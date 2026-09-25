#!/usr/bin/env node
// The Star Throne — decides who rules, writes the chronicle, redraws README + banner.
// Zero dependencies. Node 20+.
//
// Env:
//   GITHUB_TOKEN        token for the GitHub GraphQL API (Actions provides it)
//   GITHUB_REPOSITORY   "owner/name" (Actions provides it)
//   THRONE_MOCK         path to a mock JSON (offline testing, no API calls)
//   THRONE_NOW          override "now" (ISO date) for testing
//   THRONE_NO_AVATARS   "1" to skip downloading avatars into the banner

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.env.THRONE_ROOT || process.cwd();
const P = (...a) => path.join(ROOT, ...a);
const NOW = process.env.THRONE_NOW ? new Date(process.env.THRONE_NOW) : new Date();
const HOUR = 3600e3, DAY = 24 * HOUR, YEAR = 365.2425 * DAY;
const BATCH = 25;

const config = JSON.parse(await readFile(P('throne.config.json'), 'utf8'));
const [OWNER, NAME] = (process.env.GITHUB_REPOSITORY || '').split('/');
const TOKEN = process.env.GITHUB_TOKEN;
const mock = process.env.THRONE_MOCK ? JSON.parse(await readFile(process.env.THRONE_MOCK, 'utf8')) : null;

if (!mock && (!TOKEN || !OWNER || !NAME)) {
  console.error('Need GITHUB_TOKEN and GITHUB_REPOSITORY=owner/name (or THRONE_MOCK for offline runs).');
  process.exit(1);
}

const THRONES = [{ ...config.emperor, minYears: 0, maxYears: null, imperial: true }, ...config.leagues];
const throneById = Object.fromEntries(THRONES.map(t => [t.id, t]));

// ───────────────────────────── GitHub API ─────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gql(query, variables = {}) {
  for (let attempt = 1; ; attempt++) {
    let problem;
    try {
      const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'star-throne' },
        body: JSON.stringify({ query, variables }),
      });
      if (res.ok) {
        const json = await res.json();
        if (json.data) return json; // partial errors (e.g. a deleted user) are expected
        problem = JSON.stringify(json.errors);
      } else problem = `HTTP ${res.status}: ${await res.text()}`;
    } catch (err) { problem = String(err); }
    if (attempt >= 4) throw new Error(`GraphQL failed: ${problem}`);
    console.warn(`GraphQL attempt ${attempt} failed (${problem.slice(0, 200)}), retrying…`);
    await sleep(3000 * attempt);
  }
}

async function fetchStargazers() {
  if (mock) return mock.stargazers;
  const out = [];
  let after = null;
  do {
    const { data } = await gql(
      `query($o:String!,$n:String!,$a:String){repository(owner:$o,name:$n){stargazers(first:100,after:$a,orderBy:{field:STARRED_AT,direction:ASC}){pageInfo{hasNextPage endCursor} edges{starredAt node{login}}}}}`,
      { o: OWNER, n: NAME, a: after });
    const sg = data.repository.stargazers;
    for (const e of sg.edges) if (e.node) out.push({ login: e.node.login, starredAt: e.starredAt });
    after = sg.pageInfo.hasNextPage ? sg.pageInfo.endCursor : null;
  } while (after);
  return out;
}

const REPOS = (after) => `repositories(first:100${after}, ownerAffiliations:OWNER, isFork:false, privacy:PUBLIC, orderBy:{field:STARGAZERS,direction:DESC}){pageInfo{hasNextPage endCursor} nodes{name stargazerCount}}`;

// Returns { login: summary | null }
async function fetchUsers(logins) {
  const result = {};
  if (mock) {
    for (const l of logins) result[l] = mock.users[l] ? { login: l, id: 0, avatarUrl: null, ...mock.users[l], fetchedAt: NOW.toISOString() } : null;
    return result;
  }
  for (let i = 0; i < logins.length; i += BATCH) {
    const chunk = logins.slice(i, i + BATCH);
    const defs = chunk.map((_, j) => `$l${j}:String!`).join(',');
    const body = chunk.map((_, j) => `u${j}:user(login:$l${j}){login databaseId createdAt avatarUrl(size:128) ${REPOS('')}}`).join('\n');
    const vars = Object.fromEntries(chunk.map((l, j) => [`l${j}`, l]));
    const { data } = await gql(`query(${defs}){${body}}`, vars);
    for (const [j, l] of chunk.entries()) result[l] = data[`u${j}`] ? await summarize(data[`u${j}`]) : null;
    console.log(`  fetched ${Math.min(i + BATCH, logins.length)}/${logins.length} contenders`);
  }
  return result;
}

async function summarize(u) {
  let page = u.repositories;
  let stars = 0, top = page.nodes[0] || null;
  for (;;) {
    for (const r of page.nodes) stars += r.stargazerCount;
    const last = page.nodes[page.nodes.length - 1];
    // repos are sorted by stars, so we can stop as soon as they hit zero
    if (!page.pageInfo.hasNextPage || !last || last.stargazerCount === 0) break;
    const { data } = await gql(`query($l:String!,$a:String){user(login:$l){${REPOS(', after:$a')}}}`, { l: u.login, a: page.pageInfo.endCursor });
    page = data.user.repositories;
  }
  return {
    login: u.login, id: u.databaseId, createdAt: u.createdAt, avatarUrl: u.avatarUrl, stars,
    topRepo: top && top.stargazerCount > 0 ? { name: top.name, stars: top.stargazerCount } : null,
    fetchedAt: NOW.toISOString(),
  };
}

async function avatarDataUri(user) {
  if (!mock && !process.env.THRONE_NO_AVATARS && user.avatarUrl) {
    try {
      const res = await fetch(user.avatarUrl);
      if (res.ok) {
        const type = res.headers.get('content-type') || 'image/png';
        return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
      }
    } catch { /* fall through to placeholder */ }
  }
  return placeholderAvatar(user.login);
}

function placeholderAvatar(login) {
  let h = 0;
  for (const c of login) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="hsl(${hue},45%,38%)"/><text x="64" y="84" font-family="Arial,sans-serif" font-size="60" font-weight="700" fill="#fff" text-anchor="middle">${esc(login[0].toUpperCase())}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// ───────────────────────────── State ─────────────────────────────

async function readJson(file, fallback) {
  return existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : fallback;
}
async function writeText(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

const statePath = P('data', 'throne.json');
const cachePath = P('.cache', 'users.json'); // kept in the Actions cache, not in git
const state = await readJson(statePath, { version: 1, founded: NOW.toISOString(), thrones: {}, reigns: [], chronicle: [] });
const cache = await readJson(cachePath, {});

// ───────────────────────────── The battle ─────────────────────────────

const excluded = new Set([...(config.exclude || []), ...(config.excludeOwner && OWNER ? [OWNER] : [])].map(s => s.toLowerCase()));
const stargazers = (await fetchStargazers()).filter(s => !excluded.has(s.login.toLowerCase()));
const starredAt = new Map(stargazers.map(s => [s.login, s.starredAt]));
console.log(`${stargazers.length} stargazers in the realm`);

// Who needs a fresh stars count: newcomers and current rulers always, then the stalest of the rest.
const rulers = new Set(Object.values(state.thrones).map(t => t.king?.login).filter(Boolean));
const isStale = l => NOW - new Date(cache[l].fetchedAt) > config.refreshHours * HOUR;
const must = stargazers.map(s => s.login).filter(l => !cache[l] || rulers.has(l));
const optional = stargazers.map(s => s.login)
  .filter(l => cache[l] && !rulers.has(l) && isStale(l))
  .sort((a, b) => new Date(cache[a].fetchedAt) - new Date(cache[b].fetchedAt));
const toFetch = [...must, ...optional.slice(0, Math.max(0, config.maxFetchPerRun - must.length))];

if (toFetch.length) {
  console.log(`Counting stars of ${toFetch.length} contenders…`);
  const fresh = await fetchUsers(toFetch);
  for (const l of toFetch) cache[l] = fresh[l] || { login: l, missing: true, fetchedAt: NOW.toISOString() };
}
for (const l of Object.keys(cache)) if (!starredAt.has(l)) delete cache[l]; // forget people who left

const players = stargazers
  .map(s => cache[s.login])
  .filter(u => u && !u.missing)
  .map(u => ({ ...u, starredAt: starredAt.get(u.login), ageYears: (NOW - new Date(u.createdAt)) / YEAR }));
const playerByLogin = new Map(players.map(p => [p.login, p]));

const eligible = (t, p) => p.ageYears >= (t.minYears || 0) && (t.maxYears == null || p.ageYears < t.maxYears);
const byPower = (a, b) => b.stars - a.stars || new Date(a.starredAt) - new Date(b.starredAt);
const leagueOf = p => config.leagues.find(t => eligible(t, p));

const events = [];
const courts = {};

for (const t of THRONES) {
  const contenders = players.filter(p => eligible(t, p)).sort(byPower);
  const prev = state.thrones[t.id]?.king || null;
  let next = contenders[0] || null;

  // Ties go to the incumbent.
  const incumbent = prev && contenders.find(c => c.login === prev.login);
  if (incumbent && next && incumbent.stars >= next.stars) next = incumbent;

  courts[t.id] = { king: next, challengers: contenders.filter(c => c !== next).slice(0, 3), size: contenders.length };

  if ((prev?.login || null) === (next?.login || null)) continue;

  // The throne changes hands. Work out why the old ruler left.
  let type = 'vacant', to = null;
  const was = prev && playerByLogin.get(prev.login);
  if (prev) {
    if (!starredAt.has(prev.login)) type = 'abdicated';
    else if (!was) type = 'vanished';
    else if (!eligible(t, was)) { type = 'aged'; to = leagueOf(was)?.id || null; }
    else type = 'overthrown';
  }
  const openReign = prev && [...state.reigns].reverse().find(r => r.throne === t.id && r.login === prev.login && !r.to);
  if (openReign) openReign.to = NOW.toISOString();

  events.push({
    at: NOW.toISOString(), throne: t.id, type, to,
    old: prev ? { login: prev.login, stars: was ? was.stars : prev.crownedWith, reignMs: NOW - new Date(prev.since) } : null,
    new: next ? { login: next.login, stars: next.stars } : null,
  });

  state.thrones[t.id] = { king: next ? { login: next.login, since: NOW.toISOString(), crownedWith: next.stars } : null };
  if (next) state.reigns.push({ throne: t.id, login: next.login, from: NOW.toISOString(), to: null });
}

// When the same crown swap happens on a league throne and the Imperial one, tell it as one story.
const imperialEvent = events.find(e => throneById[e.throne].imperial);
const twin = imperialEvent && events.find(e => e !== imperialEvent && e.type === imperialEvent.type
  && e.old?.login === imperialEvent.old?.login && e.new?.login === imperialEvent.new?.login);
if (twin) { twin.imperialToo = true; events.splice(events.indexOf(imperialEvent), 1); }
// Imperial news leads.
events.sort((a, b) => rankEvent(b) - rankEvent(a));
function rankEvent(e) { return throneById[e.throne].imperial || e.imperialToo ? 1 : 0; }
state.chronicle = [...events, ...state.chronicle].slice(0, config.chronicleStored);

// ───────────────────────────── Text helpers ─────────────────────────────

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const fmtNum = n => Number(n).toLocaleString('en-US');
const compact = n => n < 1000 ? String(n)
  : n < 10_000 ? `${Math.floor(n / 100) / 10}k`
  : n < 1_000_000 ? `${Math.floor(n / 1000)}k`
  : `${Math.floor(n / 100_000) / 10}M`;

function fmtReign(ms) { // coarse on purpose: the README only changes once a day
  const d = Math.floor(ms / DAY);
  if (d < 1) return '< 1 day';
  if (d < 365) return `${d} day${d === 1 ? '' : 's'}`;
  return `${Math.floor(d / 365)}y ${d % 365}d`;
}
function fmtSpan(ms) {
  const m = Math.floor(ms / 60e3);
  if (m < 60) return `${Math.max(m, 1)} min`;
  const h = Math.floor(ms / HOUR);
  if (h < 48) return `${h}h`;
  return fmtReign(ms);
}
const fmtDate = iso => iso.slice(0, 10);
const fmtStamp = iso => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
function ageRange(t) {
  if (t.imperial) return 'any age';
  if (!t.minYears) return `< ${t.maxYears} year${t.maxYears === 1 ? '' : 's'}`;
  if (t.maxYears == null) return `${t.minYears}+ years`;
  return `${t.minYears}–${t.maxYears} years`;
}
const throneLabel = id => { const t = throneById[id]; return t ? `${t.emoji} ${t.name}` : id; };

function eventText(e, md = true) {
  const U = l => md ? `[@${l}](https://github.com/${l})` : `@${l}`;
  const S = n => `★${fmtNum(n)}`;
  const E = config.emperor;
  const T = `${throneLabel(e.throne)} throne${e.imperialToo ? ` and the ${E.emoji} ${E.name} crown` : ''}`;
  const both = e.imperialToo ? ' both' : '';
  const heir = e.new ? ` ${U(e.new.login)} (${S(e.new.stars)}) takes the crown${e.imperialToo ? 's' : ''}.` : ' The throne stands empty.';
  switch (e.type) {
    case 'vacant':
      return throneById[e.throne]?.imperial
        ? `🌟 ${U(e.new.login)} ascended as the first ${E.title} with ${S(e.new.stars)}.`
        : `👑 ${U(e.new.login)} claimed${both} the empty ${T} with ${S(e.new.stars)}.`;
    case 'overthrown':
      return `⚔️ ${U(e.new.login)} (${S(e.new.stars)}) overthrew ${U(e.old.login)} (${S(e.old.stars)}) and seized${both} the ${T} after a reign of ${fmtSpan(e.old.reignMs)}.`;
    case 'abdicated':
      return `🏳️ ${U(e.old.login)} abdicated${both} the ${T} after ${fmtSpan(e.old.reignMs)} by unstarring the realm.${heir}`;
    case 'aged':
      return `🎂 ${U(e.old.login)} came of age and left the ${T}${e.to ? ` for the ${throneLabel(e.to)}` : ''} after ${fmtSpan(e.old.reignMs)}.${heir}`;
    case 'vanished':
      return `👻 ${U(e.old.login)} vanished from GitHub, leaving${both} the ${T} after ${fmtSpan(e.old.reignMs)}.${heir}`;
    default:
      return `${T}: ${e.old ? U(e.old.login) : 'nobody'} → ${e.new ? U(e.new.login) : 'nobody'}`;
  }
}

// ───────────────────────────── README ─────────────────────────────

const link = l => `[@${l}](https://github.com/${l})`;
const avatar = (l, size = 20) => `<img src="https://github.com/${l}.png?size=${size * 2}" width="${size}" height="${size}" alt="">`;

function renderSection() {
  const rows = THRONES.map(t => {
    const c = courts[t.id];
    const since = state.thrones[t.id]?.king?.since;
    const name = t.imperial ? `${t.emoji} **${t.title}**` : `${t.emoji} **${t.name}**`;
    if (!c.king) return `| ${name} | ${ageRange(t)} | *vacant — star to claim* | — | — | — |`;
    const heir = c.challengers[0];
    const next = heir ? `${link(heir.login)} ★${fmtNum(heir.stars)} <sub>(needs +${fmtNum(c.king.stars - heir.stars + 1)})</sub>` : '—';
    return `| ${name} | ${ageRange(t)} | ${avatar(c.king.login)} ${link(c.king.login)} | ★ ${fmtNum(c.king.stars)} | ${fmtReign(NOW - new Date(since))} | ${next} |`;
  });

  const shown = state.chronicle.slice(0, config.chronicleShown);
  const chronicle = shown.length
    ? shown.map(e => `- <sub>${fmtStamp(e.at)}</sub> ${eventText(e)}`).join('\n')
    : '_The realm is quiet. Nobody has claimed a throne yet._';

  const E = config.emperor;
  const dynasty = state.reigns.filter(r => r.throne === E.id);
  const dynastyLine = dynasty.length
    ? `**${E.emoji} The Imperial line:** ` + dynasty.slice(-12).map(r => `${link(r.login)} <sub>(${r.to ? fmtReign(new Date(r.to) - new Date(r.from)) : 'reigning'})</sub>`).join(' → ')
    : '';

  const reigns = state.reigns
    .filter(r => !throneById[r.throne]?.imperial)
    .map(r => ({ ...r, ms: new Date(r.to || NOW) - new Date(r.from) }))
    .sort((a, b) => Math.floor(b.ms / DAY) - Math.floor(a.ms / DAY) || new Date(a.from) - new Date(b.from))
    .slice(0, config.hallOfFameSize);
  const hall = reigns.length
    ? ['| # | Ruler | Throne | Reign | |', '|---|---|---|---|---|',
       ...reigns.map((r, i) => `| ${['🥇', '🥈', '🥉'][i] || i + 1} | ${avatar(r.login)} ${link(r.login)} | ${throneLabel(r.throne)} | ${fmtReign(r.ms)} | ${r.to ? `ended ${fmtDate(r.to)}` : '**👑 reigning**'} |`)].join('\n')
    : '_No reigns yet._';

  const census = config.leagues.map(t => `${t.emoji} ${courts[t.id].size}`).join(' · ');
  const lastBattle = state.chronicle[0] ? ` · last battle ${fmtDate(state.chronicle[0].at)}` : '';

  return `<p align="center"><img src="assets/throne.svg" width="100%" alt="The Star Throne — current rulers"></p>

## ⚔️ The Thrones

| Throne | Account age | Ruler | Power | Reign | Next in line |
|---|---|---|---|---|---|
${rows.join('\n')}

<sub>${players.length} contenders in the realm — ${census}${lastBattle}</sub>

## 📜 The Chronicle

${chronicle}

## 🏛️ Hall of Fame — longest reigns

${hall}${dynastyLine ? `\n\n${dynastyLine}` : ''}`;
}

async function renderReadme() {
  const file = P('README.md');
  const START = '<!-- THRONE:START -->', END = '<!-- THRONE:END -->';
  let readme = existsSync(file) ? await readFile(file, 'utf8') : `${START}\n${END}\n`;
  if (!readme.includes(START) || !readme.includes(END)) readme = `${START}\n${END}\n\n${readme}`;
  const before = readme.slice(0, readme.indexOf(START) + START.length);
  const after = readme.slice(readme.indexOf(END));
  await writeText(file, `${before}\n${renderSection()}\n${after}`);
}

// ───────────────────────────── Banner SVG ─────────────────────────────

function rng(seed) { // mulberry32 — same sky every time, so the SVG only changes when rulers do
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const crown = (cx, top, w, color) => {
  const s = w / 50;
  const pts = [[0, 30], [0, 6], [12, 18], [25, 0], [38, 18], [50, 6], [50, 30]].map(([x, y]) => `${(cx - w / 2 + x * s).toFixed(1)},${(top + y * s).toFixed(1)}`).join(' ');
  const gems = [[0, 6], [25, 0], [50, 6]].map(([x, y]) => `<circle cx="${(cx - w / 2 + x * s).toFixed(1)}" cy="${(top + y * s).toFixed(1)}" r="${(3.2 * s).toFixed(1)}" fill="#fff6d5"/>`).join('');
  return `<polygon points="${pts}" fill="${color}" stroke="#1a1030" stroke-width="${(1.5 * s).toFixed(1)}" stroke-linejoin="round"/>${gems}`;
};

function portrait({ cx, cy, r, color, img, id, crownW }) {
  if (!img) {
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-opacity=".55" stroke-width="3" stroke-dasharray="8 7"/>
    <text x="${cx}" y="${cy + r * 0.28}" font-size="${Math.round(r * 0.8)}" font-weight="700" fill="${color}" fill-opacity=".6" text-anchor="middle">?</text>`;
  }
  return `<clipPath id="clip-${id}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>
    <circle cx="${cx}" cy="${cy}" r="${r + 9}" fill="${color}" fill-opacity=".14"/>
    <image href="${img}" x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" clip-path="url(#clip-${id})" preserveAspectRatio="xMidYMid slice"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${r > 50 ? 5 : 4}"/>
    ${crown(cx, cy - r - crownW * 0.62, crownW, color)}`;
}

const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function renderSvg() {
  const W = 1200, H = 720;
  const rand = rng(7);
  const sky = Array.from({ length: 90 }, () => {
    const x = (rand() * W).toFixed(0), y = (rand() * H).toFixed(0), r = (rand() * 1.4 + 0.3).toFixed(2), o = (rand() * 0.6 + 0.15).toFixed(2);
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" opacity="${o}"/>`;
  }).join('');

  const imgs = {};
  for (const t of THRONES) {
    const k = courts[t.id].king;
    if (k && !imgs[k.login]) imgs[k.login] = await avatarDataUri(k);
  }
  const since = id => { const s = state.thrones[id]?.king?.since; return s ? `since ${fmtDate(s)}` : ''; };

  // Emperor
  const E = config.emperor, ek = courts[E.id].king;
  const emperor = `
  <circle cx="600" cy="250" r="118" fill="url(#halo)"/>
  ${portrait({ cx: 600, cy: 250, r: 66, color: E.color, img: ek && imgs[ek.login], id: 'emperor', crownW: 70 })}
  <text x="600" y="352" font-size="13" font-weight="700" letter-spacing="5" fill="${E.color}" text-anchor="middle">EMPEROR OF ALL THRONES</text>
  <text x="600" y="386" font-size="28" font-weight="800" fill="#fff" text-anchor="middle">${ek ? `@${esc(trunc(ek.login, 22))}` : 'VACANT'}</text>
  <text x="600" y="414" font-size="16" fill="#d9d3f2" text-anchor="middle">${ek ? `<tspan fill="${E.color}" font-weight="700">★ ${compact(ek.stars)}</tspan>  ·  ${since(E.id)}` : 'star this repo to claim the empire'}</text>`;

  // Leagues
  const cw = 270, gap = 20, x0 = (W - (cw * 4 + gap * 3)) / 2, y0 = 446, ch = 244;
  const cards = config.leagues.map((t, i) => {
    const x = x0 + i * (cw + gap), cx = x + cw / 2, k = courts[t.id].king;
    return `
  <g>
    <rect x="${x}" y="${y0}" width="${cw}" height="${ch}" rx="18" fill="#ffffff" fill-opacity=".045" stroke="${t.color}" stroke-opacity=".5" stroke-width="1.5"/>
    <rect x="${x + 24}" y="${y0}" width="${cw - 48}" height="3" rx="1.5" fill="${t.color}"/>
    <text x="${cx}" y="${y0 + 36}" font-size="19" font-weight="800" letter-spacing="1.5" fill="${t.color}" text-anchor="middle">${t.emoji} ${esc(t.name.toUpperCase())}</text>
    <text x="${cx}" y="${y0 + 56}" font-size="12" fill="#a8a2c8" text-anchor="middle">account ${esc(ageRange(t))}</text>
    ${portrait({ cx, cy: y0 + 136, r: 40, color: t.color, img: k && imgs[k.login], id: t.id, crownW: 42 })}
    <text x="${cx}" y="${y0 + 204}" font-size="18" font-weight="700" fill="#fff" text-anchor="middle">${k ? `@${esc(trunc(k.login, 20))}` : 'VACANT'}</text>
    <text x="${cx}" y="${y0 + 226}" font-size="14" fill="#d9d3f2" text-anchor="middle">${k ? `<tspan fill="${t.color}" font-weight="700">★ ${compact(k.stars)}</tspan>  ·  ${since(t.id)}` : 'star this repo to claim'}</text>
  </g>`;
  }).join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji'">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="#0d0b22"/><stop offset="1" stop-color="#1d1236"/></linearGradient>
    <radialGradient id="halo"><stop offset="0" stop-color="${E.color}" stop-opacity=".32"/><stop offset="1" stop-color="${E.color}" stop-opacity="0"/></radialGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff1b8"/><stop offset="1" stop-color="#f2b43c"/></linearGradient>
  </defs>
  <rect width="${W}" height="${H}" rx="24" fill="url(#bg)"/>
  ${sky}
  <text x="600" y="72" font-size="46" font-weight="900" letter-spacing="10" fill="url(#gold)" text-anchor="middle">${esc(config.title)}</text>
  <text x="600" y="104" font-size="16" fill="#b9b3d6" text-anchor="middle">${esc(config.tagline)}</text>
  ${emperor}
  ${cards}
</svg>
`;
  await writeText(P('assets', 'throne.svg'), svg);
}

// ───────────────────────────── Write everything ─────────────────────────────

await writeText(statePath, JSON.stringify(state, null, 2) + '\n');
await writeText(cachePath, JSON.stringify(cache));
await renderSvg();
await renderReadme();

for (const e of events) console.log(eventText(e, false));
if (!events.length) console.log('No change of power.');

if (process.env.GITHUB_OUTPUT) {
  const headline = events.length ? eventText(events[0], false).replace(/[\r\n]/g, ' ') : '';
  await appendFile(process.env.GITHUB_OUTPUT, `headline=${headline}\n`);
}
