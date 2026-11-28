// SPRtix - match list / live score updater (runs on GitHub Actions, no packages needed)
// Reads data/settings.json (matchApiUrls, matchApiEnabled), calls the API link(s),
// and writes the cleaned match list to data/matchApi.json for the app.
'use strict';
const fs = require('fs');
const cleanText = (x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim();

var TEAM_ALIAS = { ind: 'India', aus: 'Australia', pak: 'Pakistan', eng: 'England', sa: 'South Africa', rsa: 'South Africa', nz: 'New Zealand',
    sl: 'Sri Lanka', ban: 'Bangladesh', wi: 'West Indies', afg: 'Afghanistan', zim: 'Zimbabwe', ire: 'Ireland', nep: 'Nepal' };
function h32(s) { var h = 0; s = String(s); for (var i = 0; i < s.length; i++)
    h = (h * 31 + s.charCodeAt(i)) >>> 0; return h.toString(36); }
// "INDIA" / "india" / " India  [IND] " / "Ind"  ->  "India"
function fixTeamName(n) {
    n = cleanText(String(n == null ? '' : n).replace(/\[[^\]]*\]/g, ' '));
    if (!n)
        return '';
    if (/^(tbc|tba|tbd)$/i.test(n))
        return 'TBA';
    if (TEAM_ALIAS[n.toLowerCase()])
        return TEAM_ALIAS[n.toLowerCase()];
    if ((n === n.toUpperCase() && n.length > 4) || n === n.toLowerCase()) {
        n = n.toLowerCase().replace(/(^|[\s\-'.])([a-z])/g, function (m, p, c) { return p + c.toUpperCase(); });
    }
    return n;
}
function apiTime(s) {
    if (s == null || s === '')
        return NaN;
    if (typeof s === 'number')
        return s < 1e12 ? s * 1000 : s;
    s = String(s).trim().replace(' ', 'T');
    if (/^\d{4}-\d\d-\d\d$/.test(s))
        s += 'T00:00:00Z';
    else if (!/(z|[+-]\d\d:?\d\d)$/i.test(s))
        s += 'Z';
    return Date.parse(s);
}
function mkApiEvent(o) {
    var e = {
        id: 'api_' + o.id, sport: cleanText(o.sport || 'other').toLowerCase(),
        league: cleanText(o.league), leagueLogo: o.leagueLogo || '',
        t1: { name: fixTeamName(o.n1) || 'TBA', logo: o.l1 || '' }, t2: { name: fixTeamName(o.n2) || 'TBA', logo: o.l2 || '' },
        startMs: o.startMs, durMs: o.durMs || 6 * 3600000, manual: o.state || 'upcoming', hot: false, channels: [], api: true,
        score1: o.s1 || '', score2: o.s2 || '', note: cleanText(o.note)
    };
    e.title = e.t1.name + ' vs ' + e.t2.name;
    e.search = (e.t1.name + ' ' + e.t2.name + ' ' + e.league + ' ' + e.sport).toLowerCase();
    return e;
}
function cricScore(m, name, short) {
    var nm = cleanText(name).toLowerCase(), sh = cleanText(short).toLowerCase();
    return (m.score || []).filter(function (s) {
        var inn = String(s.inning || '').toLowerCase();
        return (nm && inn.indexOf(nm) === 0) || (sh && inn.indexOf(sh) === 0);
    }).map(function (s) { return s.r + '/' + s.w + (s.o != null ? ' (' + s.o + ')' : ''); }).join(' & ');
}
function parseCricApi(j) {
    return (j.data || []).filter(function (m) { return m && m.id; }).map(function (m) {
        var info = m.teamInfo || [], names = m.teams || [], n1, n2;
        if (names.length >= 2) {
            n1 = names[0];
            n2 = names[1];
        }
        else if (info.length >= 2) {
            n1 = info[0].name;
            n2 = info[1].name;
        }
        else {
            var p = String(m.name || '').split(',')[0].split(/\s+vs\.?\s+/i);
            n1 = p[0];
            n2 = p[1];
        }
        var l1 = '', l2 = '', sh1 = '', sh2 = '';
        info.forEach(function (ti) {
            var k = cleanText(ti.name).toLowerCase();
            if (k === cleanText(n1).toLowerCase()) {
                l1 = ti.img || '';
                sh1 = ti.shortname || '';
            }
            else if (k === cleanText(n2).toLowerCase()) {
                l2 = ti.img || '';
                sh2 = ti.shortname || '';
            }
        });
        var nm = String(m.name || ''), c = nm.indexOf(',');
        var type = String(m.matchType || '').toLowerCase();
        var state = m.matchEnded ? 'finished' : (m.matchStarted ? 'live' : 'upcoming');
        return mkApiEvent({
            id: m.id, sport: 'cricket', n1: n1, n2: n2, l1: l1, l2: l2,
            league: (c > -1 ? nm.slice(c + 1) : '') || String(m.matchType || '').toUpperCase(),
            startMs: apiTime(m.dateTimeGMT || m.date), state: state,
            durMs: type === 'test' ? 120 * 3600000 : (type === 'odi' ? 9 * 3600000 : 4.5 * 3600000),
            s1: cricScore(m, n1, sh1), s2: cricScore(m, n2, sh2), note: state === 'upcoming' ? m.venue : m.status
        });
    });
}
function fdState(s) { s = String(s || '').toUpperCase(); return /IN_PLAY|PAUSED|LIVE/.test(s) ? 'live' : (/FINISHED|AWARDED/.test(s) ? 'finished' : 'upcoming'); }
function parseFootballData(j) {
    return (j.matches || []).filter(function (m) { return m && m.id; }).map(function (m) {
        var ft = (m.score && m.score.fullTime) || {}, st = fdState(m.status);
        return mkApiEvent({
            id: m.id, sport: 'football', n1: m.homeTeam && (m.homeTeam.name || m.homeTeam.shortName), n2: m.awayTeam && (m.awayTeam.name || m.awayTeam.shortName),
            l1: m.homeTeam && m.homeTeam.crest, l2: m.awayTeam && m.awayTeam.crest,
            league: m.competition && m.competition.name, leagueLogo: m.competition && m.competition.emblem,
            startMs: apiTime(m.utcDate), state: st, durMs: 3 * 3600000,
            s1: st !== 'upcoming' && ft.home != null ? String(ft.home) : '', s2: st !== 'upcoming' && ft.away != null ? String(ft.away) : ''
        });
    });
}
function parseApiFootball(j) {
    return (j.response || []).filter(function (m) { return m && m.fixture; }).map(function (m) {
        var sh = String((m.fixture.status && m.fixture.status.short) || '').toUpperCase();
        var st = /^(1H|HT|2H|ET|BT|P|LIVE|INT)$/.test(sh) ? 'live' : (/^(FT|AET|PEN|AWD|WO)$/.test(sh) ? 'finished' : 'upcoming');
        var g = m.goals || {}, t = m.teams || {}, lg = m.league || {};
        return mkApiEvent({
            id: m.fixture.id, sport: 'football', n1: t.home && t.home.name, n2: t.away && t.away.name, l1: t.home && t.home.logo, l2: t.away && t.away.logo,
            league: lg.name, leagueLogo: lg.logo, startMs: apiTime(m.fixture.date), state: st, durMs: 3 * 3600000,
            s1: st !== 'upcoming' && g.home != null ? String(g.home) : '', s2: st !== 'upcoming' && g.away != null ? String(g.away) : ''
        });
    });
}
function parseSportsDb(j) {
    return (j.events || j.event || []).filter(function (m) { return m && m.idEvent; }).map(function (m) {
        var stx = String(m.strStatus || ''), has = m.intHomeScore != null && m.intHomeScore !== '';
        var st = /finish|^ft$|final|aet|pen/i.test(stx) ? 'finished' : (/not started|^ns$|postponed|cancel|^$/i.test(stx) && !has ? 'upcoming' : (has ? 'live' : 'upcoming'));
        return mkApiEvent({
            id: m.idEvent, sport: m.strSport || 'other', n1: m.strHomeTeam, n2: m.strAwayTeam, l1: m.strHomeTeamBadge, l2: m.strAwayTeamBadge,
            league: m.strLeague, startMs: apiTime(m.strTimestamp || (m.dateEvent ? m.dateEvent + 'T' + (m.strTime || '00:00:00') : '')),
            state: st, durMs: 3 * 3600000, s1: has ? String(m.intHomeScore) : '', s2: has && m.intAwayScore != null ? String(m.intAwayScore) : ''
        });
    });
}
function parseMatchApi(j) {
    if (!j || typeof j !== 'object')
        return [];
    if (j.status === 'failure')
        throw new Error('API said: ' + (j.reason || 'failure'));
    if (Array.isArray(j.data))
        return parseCricApi(j);
    if (Array.isArray(j.matches))
        return parseFootballData(j);
    if (Array.isArray(j.response))
        return parseApiFootball(j);
    if (Array.isArray(j.events) || Array.isArray(j.event))
        return parseSportsDb(j);
    return [];
}

async function fetchJson(spec) {
    const parts = spec.split('|');
    let url = parts[0].trim();
    const headers = {};
    parts.slice(1).forEach((p) => { const i = p.indexOf('='); if (i > 0) headers[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
    url = url.replace(/\{\{KEY\}\}/g, process.env.MATCH_API_KEY || '');
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
}

async function main() {
    const SETTINGS = 'data/settings.json', OUT = 'data/matchApi.json';
    let st = {};
    try { st = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) || {}; } catch (e) { console.log('no settings.json'); return; }
    const off = String(st.matchApiEnabled == null ? '' : st.matchApiEnabled).toLowerCase() === 'no';
    const urls = String(st.matchApiUrls || st.matchApiUrl || '').split(/\r?\n/).map((x) => x.trim()).filter((x) => /^https?:\/\//i.test(x));
    if (off || !urls.length) { console.log('Match API is off or has no links'); return; }

    const results = await Promise.all(urls.map((u) =>
        fetchJson(u).then(parseMatchApi).catch((err) => { console.log('API failed:', err.message); return null; })));
    const ok = results.filter(Boolean);
    if (!ok.length) { console.log('All APIs failed - keeping the old file'); return; }

    const map = {};
    ok.forEach((list) => list.forEach((e) => { map[e.id] = e; })); // later lines (live score) win
    const ev = JSON.parse(JSON.stringify(Object.keys(map).map((k) => map[k])));

    let old = null;
    try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { }
    const same = old && JSON.stringify(old.ev) === JSON.stringify(ev);
    if (same && Date.now() - old.t < 50 * 60000) { console.log('No change'); return; } // no needless commits
    fs.writeFileSync(OUT, JSON.stringify({ t: Date.now(), ev }));
    console.log('Saved ' + ev.length + ' matches');
}
main().catch((e) => { console.log('Error:', e.message); });
