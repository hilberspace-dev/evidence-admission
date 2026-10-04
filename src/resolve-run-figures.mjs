// The run-file figure resolver (`[r:…]` markers).
//
// WHY. A figure written in prose (a memo, a report, a pull-request body) is
// usually copied from a run file an agent produced. Nothing checks the copy:
// reviewers re-derive numbers by hand, and a wrong sentence about correct data
// survives review. A marker ties the written figure to the run file and a
// selector; this script reads the value and compares it with what was written.
//
// Marker syntax, written bare or inside an HTML comment (never in backticks,
// which mark prose ABOUT the syntax):
//   [r:<path>#<json.path>] 12.5          a JSON value, by path or [key=value] row
//   [r:<path>#/regex with (one) group/] 0,42   a text value, by one capture group
//   [r:<path>#<selector>="exact text"]    a non-numeric value, compared as a string
// <path> resolves against the evidence root, or against the repository root when
// it matches `trackedPathPattern` (configuration).
//
// HONEST LIMIT: only MARKED figures are checked, and this script cannot know
// that a marker is missing. What it buys is that a marked figure cannot drift
// from the run that produced it, and that a marker pointing at nothing FAILS
// (exit 2) rather than passing quietly.
//
// Exit codes: 0 every marker MATCH (or EXAMPLE), 1 at least one MISMATCH,
// 2 at least one UNRESOLVED (outranks MISMATCH), or a usage/configuration error.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { DEFAULT_CONFIG, entryIsKnown, loadConfig } from './config.mjs';

/** Marker paths matching this resolve against the REPOSITORY, not the evidence
 *  root: a tracked baseline is a legitimate figure source too. */
export const DEFAULT_TRACKED_PATH_RE = new RegExp(DEFAULT_CONFIG.trackedPathPattern);

/** Parse ONE marker starting at `[r:` in `line`; null when it does not parse. */
function parseOneMarker(line, start) {
  let i = start + 3;
  const hash = line.indexOf('#', i);
  if (hash < 0) return null;
  const path = line.slice(i, hash);
  if (path.length === 0 || /[\]\s]/.test(path)) return null;
  i = hash + 1;
  let selector;
  if (line[i] === '/') {
    // Regex selector: ends at the next unescaped `/`, so a character class may
    // contain `]` (`/ratio ([0-9.]+)/`).
    let k = i + 1;
    while (k < line.length && line[k] !== '/') k += line[k] === '\\' ? 2 : 1;
    if (k >= line.length) return null;
    k += 1;
    while (k < line.length && /[a-z]/.test(line[k])) k += 1; // regex flags
    selector = line.slice(i, k);
    i = k;
  } else {
    // JSON path: `]` at bracket depth 0 terminates the marker, a top-level `=`
    // starts the quoted-string form.
    let depth = 0;
    let k = i;
    for (; k < line.length; k += 1) {
      const c = line[k];
      if (c === '[') depth += 1;
      else if (c === ']') { if (depth === 0) break; depth -= 1; }
      else if (c === '=' && depth === 0) break;
    }
    selector = line.slice(i, k);
    if (selector.length === 0) return null;
    i = k;
  }
  let expected = null;
  if (line[i] === '=') {
    if (line[i + 1] !== '"') return null;
    const close = line.indexOf('"', i + 2);
    if (close < 0) return null;
    expected = line.slice(i + 2, close);
    i = close + 1;
  }
  if (line[i] !== ']') return null;
  return { marker: { path, selector, expected }, end: i + 1 };
}

/** The minus signs prose actually uses: ASCII, U+2212 MINUS SIGN and U+2013
 *  EN DASH glued to a digit. All three read as `-`; dropping the typographic
 *  ones would let a wrong sign MATCH. */
const SIGN_RE = /[-+−–]/;
const normaliseSign = (s) => s.replace(/[−–]/g, '-');

/** The figure that follows a marker: a bounded run of PUNCTUATION may sit
 *  between them (`-->`, `**`, a backtick), never a letter or `=`, so
 *  `n=1 → 0,999` does not silently check the `1`; a sign at its end is the
 *  figure's own sign. A space-grouped figure (`7 419`) is returned with its
 *  group so the reader refuses it rather than reading `7`. */
function writtenFigureAfter(line, end) {
  // The group tail admits the spaces prose uses for grouping (ASCII, NBSP,
  // narrow NBSP, thin space) and applies ONLY when the figure has no decimal
  // separator: `7 419` is refused, `0,742 102 trials` is 0,742 followed by an
  // unrelated count.
  const m = /^([^\d\n\p{L}=]{0,12}?)([-+−–]?\d+(?:[.,]\d+)*)([ \u00a0\u202f\u2009]\d{3}(?!\d))?/u.exec(line.slice(end));
  if (!m) return null;
  const sign = SIGN_RE.test(m[1].slice(-1)) && !SIGN_RE.test(m[2][0]) ? m[1].slice(-1) : '';
  const groupTail = m[3] && !/[.,]/.test(m[2]) ? ' ' + m[3].slice(1) : '';
  return normaliseSign(sign + m[2]) + groupTail;
}

/** A `[r:` written ABOUT the syntax: documentation spells the shape with `…`
 *  and `<placeholders>`, and no real path holds either. EXAMPLE, never dropped.
 *  Judged on the PATH ONLY: testing the whole unparsed fragment would let a
 *  REAL marker that lost its `]` inside `<!-- -->` carry the comment's `-->`
 *  into the test, be classed EXAMPLE and exit 0. */
const PLACEHOLDER_RE = /[…<>]/;

/** The `<path>` a marker starts with, parsed or not: everything after `[r:` up
 *  to the first `#`, whitespace, `]` or `-->`. */
function attemptedPath(line, start) {
  const rest = line.slice(start + 3);
  const cut = rest.search(/[#\s\]]|-->/);
  return cut < 0 ? rest : rest.slice(0, cut);
}

/** A near-miss prefix (`[R:`, `[r :`) is not a marker and must not vanish
 *  either: anything that looks like the prefix is reconciled against what the
 *  scanner accounted for. */
const NEAR_MISS_RE = /\[\s*r\s*:/gi;

/** Text QUOTED as code is prose about the syntax, never a live marker. A LIVE
 *  marker is written bare or inside `<!-- -->`, never in backticks.
 *
 *  "Quoted" follows CommonMark over the WHOLE text, not a per-line backtick
 *  parity: hard-wrapped prose puts a code span's close on the next line, and a
 *  per-line count would then quote everything after it, including a live
 *  marker beside a wrong figure. The rules applied here:
 *   · a fence is a line starting with ≤ 3 spaces and ≥ 3 backticks or tildes;
 *     it closes on a later line whose run of the SAME character is at least as
 *     long and carries nothing else; its body is quoted. An UNCLOSED fence is
 *     reported as an UNRESOLVED row and quotes NOTHING (fail closed);
 *   · outside fences, a run of n backticks opens an inline span that closes on
 *     the next run of EXACTLY n backticks within the same paragraph (a blank
 *     line ends the paragraph; spans may cross a line break); an unmatched run
 *     quotes nothing.
 *  Returns global-offset intervals plus the unclosed fences' line numbers. */
function codeQuoting(text) {
  const lines = text.split('\n');
  const offsets = [];
  let off = 0;
  for (const l of lines) { offsets.push(off); off += l.length + 1; }
  const intervals = [];
  const unclosed = [];
  const fenced = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length;) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (!m) { i += 1; continue; }
    const ch = m[1][0];
    const closeRe = new RegExp(`^ {0,3}${ch === '`' ? '`' : '~'}{${m[1].length},}\\s*$`);
    let closed = -1;
    for (let j = i + 1; j < lines.length; j += 1) if (closeRe.test(lines[j])) { closed = j; break; }
    if (closed < 0) { unclosed.push(i + 1); i += 1; continue; }
    for (let k = i; k <= closed; k += 1) fenced[k] = true;
    intervals.push([offsets[i], offsets[closed] + lines[closed].length]);
    i = closed + 1;
  }
  for (let p = 0; p < lines.length;) {
    if (fenced[p] || lines[p].trim() === '') { p += 1; continue; }
    let q = p;
    while (q < lines.length && !fenced[q] && lines[q].trim() !== '') q += 1;
    const paraStart = offsets[p];
    const para = text.slice(paraStart, offsets[q - 1] + lines[q - 1].length);
    const runs = [...para.matchAll(/`+/g)].map((r) => ({ at: r.index, len: r[0].length }));
    for (let r = 0; r < runs.length;) {
      let s = r + 1;
      while (s < runs.length && runs[s].len !== runs[r].len) s += 1;
      if (s < runs.length) { intervals.push([paraStart + runs[r].at, paraStart + runs[s].at + runs[s].len]); r = s + 1; } else r += 1;
    }
    p = q;
  }
  return { intervals, unclosed, offsets };
}

/** Does `[r:` at `start` sit beside a figure? For an UNPARSED marker the end is
 *  unknown, so the figure is looked for after the first `]` or `-->` that
 *  follows. */
function unparsedBesideFigure(line, start) {
  return /(?:\]|-->)[^\d\n\p{L}=]{0,12}?[-+−–]?\d/u.test(line.slice(start));
}

/** Every `[r:` in `text`, plus the ones that do not parse: a marker this
 *  scanner cannot read must fail, never vanish. */
export function scanMarkers(rawText) {
  const markers = [];
  const unreadable = [];
  const placeholders = [];
  const text = rawText.replace(/\r\n?/g, '\n');
  const { intervals, unclosed, offsets } = codeQuoting(text);
  const lines = text.split('\n');
  for (const n of unclosed) {
    unreadable.push({ line: n, text: lines[n - 1].slice(0, 40), reason: `unclosed code fence opened at line ${n} — nothing after it is treated as quoted; close it` });
  }
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n];
    const quoted = (pos) => { const g = offsets[n] + pos; return intervals.some(([a, b]) => g >= a && g < b); };
    const spans = [];
    let at = 0;
    for (;;) {
      const start = line.indexOf('[r:', at);
      if (start < 0) break;
      const parsed = parseOneMarker(line, start);
      if (!parsed) {
        const end = line.indexOf(']', start);
        const fragment = line.slice(start, end < 0 ? start + 70 : end + 1);
        if (quoted(start)) placeholders.push({ line: n + 1, text: fragment });
        else if (!PLACEHOLDER_RE.test(attemptedPath(line, start))) unreadable.push({ line: n + 1, text: fragment });
        else if (unparsedBesideFigure(line, start)) unreadable.push({ line: n + 1, text: fragment, reason: 'a placeholder path beside a figure — fill in the path, or quote the example as code' });
        else placeholders.push({ line: n + 1, text: fragment });
        at = start + 3;
        continue;
      }
      at = parsed.end;
      spans.push([start, parsed.end]);
      const written = writtenFigureAfter(line, parsed.end);
      if (quoted(start)) {
        placeholders.push({ line: n + 1, text: line.slice(start, parsed.end) });
      } else if (PLACEHOLDER_RE.test(parsed.marker.path) && written !== null) {
        // A template path left unfilled BESIDE a figure is the copy-paste case:
        // the figure is real and nothing checks it. Documentation never puts a
        // live figure after a placeholder outside code.
        unreadable.push({ line: n + 1, text: line.slice(start, parsed.end), reason: 'a placeholder path beside a figure — fill in the path, or quote the example as code' });
      } else {
        markers.push({ line: n + 1, ...parsed.marker, written });
      }
    }
    for (const m of line.matchAll(NEAR_MISS_RE)) {
      if (m[0] === '[r:') continue;
      if (spans.some(([s, e]) => m.index >= s && m.index < e)) continue; // inside a real marker's own selector
      const entry = { line: n + 1, text: line.slice(m.index, m.index + 40), nearMiss: true };
      (quoted(m.index) ? placeholders : unreadable).push(entry);
    }
  }
  return { markers, unreadable, placeholders };
}

/** The readings a written figure admits. `0,313` and `12.4` are decimals,
 *  `1.234,56` is grouped, and `7,419` is AMBIGUOUS (both 7.419 and 7 419), so
 *  BOTH are returned and the report says which one matched, because guessing is
 *  how a figure silently changes meaning. Ambiguity needs one separator, three
 *  digits after it and a short integer part with no leading zero, which is why
 *  `0,313` has only one reading. */
export function readWrittenFigure(written) {
  if (typeof written !== 'string') return [];
  const w = normaliseSign(written);
  if (!/^[-+]?[\d.,]+$/.test(w)) return []; // a space-grouped `7 419` or any letter: refused, never guessed
  const sign = w.startsWith('-') ? -1 : 1;
  const body = w.replace(/^[-+]/, '');
  const seps = (body.match(/[.,]/g) ?? []).length;
  const out = [];
  if (seps === 0) out.push({ value: sign * Number(body), decimals: 0, reading: 'integer' });
  else if (seps === 1) {
    const [, int, sep, frac] = /^(\d+)([.,])(\d+)$/.exec(body) ?? [];
    if (int === undefined) return [];
    out.push({ value: sign * Number(`${int}.${frac}`), decimals: frac.length, reading: `'${sep}' as decimal separator` });
    if (frac.length === 3 && int.length <= 3 && !int.startsWith('0')) {
      out.push({ value: sign * Number(`${int}${frac}`), decimals: 0, reading: `'${sep}' as thousands separator` });
    }
  } else if (/^\d{1,3}(?:([.,])\d{3})(?:\1\d{3})+$/.test(body)) {
    // ONE repeated separator, every group of three: `1.234.567` / `1,234,567`
    // is a grouped INTEGER, not 1234.567.
    out.push({ value: sign * Number(body.replace(/[.,]/g, '')), decimals: 0, reading: 'grouped integer' });
  } else {
    const last = Math.max(body.lastIndexOf('.'), body.lastIndexOf(','));
    const head = body.slice(0, last).replace(/[.,]/g, '');
    const frac = body.slice(last + 1);
    if (!/^\d+$/.test(head) || !/^\d+$/.test(frac)) return [];
    out.push({ value: sign * Number(`${head}.${frac}`), decimals: frac.length, reading: 'grouped, last separator decimal' });
  }
  return out.filter((c) => Number.isFinite(c.value));
}

function within(root, abs) {
  const rel = relative(root, abs);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Where a marker's `<path>` lives on disk. */
export function resolveMarkerPath(path, { evidenceRoot, repoRoot, trackedPathRe = DEFAULT_TRACKED_PATH_RE }) {
  if (path.split(/[/\\]/).includes('..')) {
    return { ok: false, reason: 'a marker path may not contain ".."' };
  }
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path)) {
    const abs = resolve(path);
    if (within(evidenceRoot, abs) || within(repoRoot, abs)) return { ok: true, abs };
    return { ok: false, reason: 'an absolute marker path must lie under the evidence root or the repository' };
  }
  const tracked = trackedPathRe.test(path);
  return { ok: true, abs: resolve(tracked ? repoRoot : evidenceRoot, path), tracked };
}

function selectJsonPath(root, selector) {
  let cur = root;
  const re = /\.?([^.[\]]+)|\[([^\]]+)\]/g;
  let consumed = 0;
  let m;
  while ((m = re.exec(selector)) !== null) {
    if (m.index !== consumed) break;
    consumed = m.index + m[0].length;
    if (m[1] !== undefined) {
      if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !(m[1] in cur)) {
        return { ok: false, reason: `no key "${m[1]}" at that point in the JSON` };
      }
      cur = cur[m[1]];
    } else if (/^\d+$/.test(m[2])) {
      if (!Array.isArray(cur)) return { ok: false, reason: `[${m[2]}] indexes something that is not an array` };
      if (Number(m[2]) >= cur.length) return { ok: false, reason: `index ${m[2]} is past the end (${cur.length} elements)` };
      cur = cur[Number(m[2])];
    } else {
      // `[key=value]`: an index is brittle across a regenerated file; a named
      // row is not, and MORE than one match is a failure, not a pick.
      const eq = m[2].indexOf('=');
      if (eq < 0) return { ok: false, reason: `[${m[2]}] is neither an index nor <key>=<value>` };
      if (!Array.isArray(cur)) return { ok: false, reason: `[${m[2]}] filters something that is not an array` };
      const key = m[2].slice(0, eq);
      const want = m[2].slice(eq + 1);
      const hits = cur.filter((row) => row && typeof row === 'object' && String(row[key]) === want);
      if (hits.length === 0) return { ok: false, reason: `no array element with ${key}=${want}` };
      if (hits.length > 1) return { ok: false, reason: `${hits.length} array elements have ${key}=${want} — the selector must name one` };
      cur = hits[0];
    }
  }
  if (consumed !== selector.length) return { ok: false, reason: `unreadable JSON path at "${selector.slice(consumed)}"` };
  return { ok: true, value: cur };
}

function selectByRegex(text, selector) {
  const close = selector.lastIndexOf('/');
  const body = selector.slice(1, close);
  const flags = selector.slice(close + 1);
  let re;
  try {
    re = new RegExp(body, flags.includes('g') ? flags : `${flags}g`);
    if (new RegExp(`${body}|`).exec('').length - 1 !== 1) {
      return { ok: false, reason: 'a regex selector needs exactly one capture group' };
    }
  } catch (err) {
    return { ok: false, reason: `the regex selector does not compile: ${err.message}` };
  }
  const found = [...text.matchAll(re)].map((m) => m[1]).filter((v) => v !== undefined);
  if (found.length === 0) return { ok: false, reason: 'the regex selector matches nothing in that file' };
  const uniq = [...new Set(found.map((v) => v.trim()))];
  if (uniq.length > 1) {
    return { ok: false, reason: `the regex selector captures ${uniq.length} different values (${uniq.slice(0, 3).join(', ')}) — narrow it` };
  }
  return { ok: true, value: uniq[0] };
}

/** Read the value a marker points at, or say why it cannot be read. */
export function resolveMarkerValue(marker, roots) {
  const path = resolveMarkerPath(marker.path, roots);
  if (!path.ok) return path;
  if (!existsSync(path.abs)) {
    const missingRoot = !path.tracked && !existsSync(roots.evidenceRoot);
    return {
      ok: false,
      reason: missingRoot
        ? `the evidence root does not exist (${roots.evidenceRoot}) — run files are often untracked, so this check needs the checkout that holds them`
        : `the file does not exist (${path.abs})`,
    };
  }
  let text;
  try {
    text = readFileSync(path.abs, 'utf8');
  } catch (err) {
    return { ok: false, reason: `the file cannot be read: ${err.message}` };
  }
  if (marker.selector.startsWith('/')) return selectByRegex(text, marker.selector);
  if (!marker.path.endsWith('.json')) {
    return { ok: false, reason: 'a non-JSON file needs a /regex/ selector with one capture group' };
  }
  try {
    return selectJsonPath(JSON.parse(text), marker.selector);
  } catch (err) {
    return { ok: false, reason: `the JSON does not parse: ${err.message}` };
  }
}

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

/** MATCH / MISMATCH for a marker whose value WAS read. */
export function judgeMarker(marker, value) {
  if (marker.expected !== null) {
    return norm(value) === norm(marker.expected)
      ? { status: 'MATCH', message: `"${norm(marker.expected)}"` }
      : { status: 'MISMATCH', message: `found "${norm(value)}", the marker asserts "${norm(marker.expected)}"` };
  }
  if (marker.written === null) {
    return { status: 'UNRESOLVED', message: 'no figure follows the marker (and it carries no ="…" assertion)' };
  }
  // A number, or a string that IS a number; never `Number()`'s coercion of an
  // empty capture, an empty array or a one-element array to a figure.
  const numeric = typeof value === 'number'
    || (typeof value === 'string' && /^[-+−–]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(norm(value)));
  const measured = numeric ? Number(normaliseSign(norm(value))) : NaN;
  if (!Number.isFinite(measured)) {
    return { status: 'UNRESOLVED', message: `the resolved value "${norm(value)}" is not a number` };
  }
  const readings = readWrittenFigure(marker.written);
  if (readings.length === 0) {
    return { status: 'UNRESOLVED', message: `"${marker.written}" is not a figure this resolver can read` };
  }
  for (const c of readings) {
    // Half a unit of the printed precision, with a relative epsilon: rounding
    // `measured` in binary would decide a halfway value by float luck (1.005 is
    // stored as 1.00499…), flagging a correct half-up "1,01".
    const half = 0.5 / 10 ** c.decimals;
    if (Math.abs(measured - c.value) <= half * (1 + 1e-9)) {
      const note = readings.length > 1 ? ` (ambiguous figure, matched with ${c.reading})` : '';
      return { status: 'MATCH', message: `${measured}${note}` };
    }
  }
  return {
    status: 'MISMATCH',
    message: `found ${measured}, written ${marker.written} (read as ${readings.map((c) => c.value).join(' or ')})`,
  };
}

/**
 * Resolve every marker in `files` (already-read text may be passed as
 * `{ label, text }` in `sources`, which is how `--pr` feeds a pull-request body in).
 */
export function resolveMarkerFiles({ files = [], sources = [], evidenceRoot, repoRoot, trackedPathRe = DEFAULT_TRACKED_PATH_RE }) {
  const roots = { evidenceRoot, repoRoot, trackedPathRe };
  const rows = [];
  const inputs = [
    ...files.map((f) => ({ label: f, text: readFileSync(f, 'utf8') })),
    ...sources,
  ];
  for (const input of inputs) {
    const { markers, unreadable, placeholders } = scanMarkers(input.text);
    for (const e of placeholders) {
      rows.push({ file: input.label, line: e.line, marker: e.text, status: 'EXAMPLE', message: 'prose about the marker syntax — nothing to resolve' });
    }
    for (const u of unreadable) {
      rows.push({
        file: input.label,
        line: u.line,
        marker: u.text,
        status: 'UNRESOLVED',
        message: u.reason ?? (u.nearMiss ? 'a near-miss marker prefix (`[R:`, `[r :`) — write `[r:` or remove it' : 'the marker itself does not parse'),
      });
    }
    for (const marker of markers) {
      const where = { file: input.label, line: marker.line, marker: `[r:${marker.path}#${marker.selector}]` };
      if (PLACEHOLDER_RE.test(marker.path)) {
        // A documentation PLACEHOLDER (`<topic>/run/…`). It is PRINTED rather
        // than dropped: a marker never disappears quietly, so the reader sees
        // the row and its class.
        rows.push({ ...where, status: 'EXAMPLE', message: 'a documentation placeholder path — nothing to resolve' });
        continue;
      }
      const read = resolveMarkerValue(marker, roots);
      if (!read.ok) {
        rows.push({ ...where, status: 'UNRESOLVED', message: read.reason });
        continue;
      }
      rows.push({ ...where, ...judgeMarker(marker, read.value) });
    }
  }
  rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const counts = {
    markers: rows.length,
    match: rows.filter((r) => r.status === 'MATCH').length,
    example: rows.filter((r) => r.status === 'EXAMPLE').length,
    mismatch: rows.filter((r) => r.status === 'MISMATCH').length,
    unresolved: rows.filter((r) => r.status === 'UNRESOLVED').length,
    // An ambiguous MATCH (`7,419` read as 7 419 OR 7.419) is a MATCH a reviewer
    // should still look at; it is counted in the summary so it is not buried.
    ambiguous: rows.filter((r) => r.status === 'MATCH' && /ambiguous/.test(r.message)).length,
  };
  // UNRESOLVED outranks MISMATCH: a marker that resolves to nothing means the
  // check did not happen at all.
  const exitCode = counts.unresolved > 0 ? 2 : counts.mismatch > 0 ? 1 : 0;
  const summary = `resolve-run-figures: ${counts.markers} markers in ${inputs.length} inputs — `
    + `${counts.match} MATCH, ${counts.mismatch} MISMATCH, ${counts.unresolved} UNRESOLVED, ${counts.example} EXAMPLE`
    + (counts.ambiguous > 0 ? `, ${counts.ambiguous} of the MATCHes ambiguous` : '')
    + ` (evidence root: ${evidenceRoot})`;
  return { rows, counts, exitCode, summary, evidenceRoot };
}

/** The repository root and the evidence root. In a linked worktree the
 *  evidence root is taken from the MAIN checkout (`--git-common-dir`), because
 *  untracked run files live there. EA_EVIDENCE_ROOT overrides it. */
function defaultRoots(cwd, evidenceRootSetting) {
  let repoRoot = cwd;
  let evidenceRoot = resolve(cwd, evidenceRootSetting);
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || cwd;
    evidenceRoot = resolve(common, '..', evidenceRootSetting);
  } catch { /* not a checkout: the cwd-relative defaults stand */ }
  return { repoRoot, evidenceRoot: process.env.EA_EVIDENCE_ROOT ? resolve(process.env.EA_EVIDENCE_ROOT) : evidenceRoot };
}

function main(argv) {
  const files = [];
  const sources = [];
  let asJson = false;
  let pr = null;
  let evidenceRootFlag = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') asJson = true;
    else if (argv[i] === '--pr') pr = argv[i += 1];
    else if (argv[i] === '--evidence-root') evidenceRootFlag = argv[i += 1];
    else files.push(argv[i]);
  }
  if (files.length === 0 && pr === null) {
    process.stderr.write('usage: node src/resolve-run-figures.mjs [--json] [--pr <number>] [--evidence-root <dir>] <file>…\n');
    return 2;
  }
  const cwdRoots = defaultRoots(process.cwd(), DEFAULT_CONFIG.evidenceRoot);
  const loaded = loadConfig(cwdRoots.repoRoot);
  if (!loaded.ok) {
    process.stderr.write(`resolve-run-figures: the configuration cannot be read. ${loaded.error}\n`);
    return 2;
  }
  const roots = defaultRoots(process.cwd(), loaded.config.evidenceRoot);
  if (evidenceRootFlag) roots.evidenceRoot = resolve(evidenceRootFlag);
  if (pr) {
    // Not covered by the tests (it needs the network): one `gh` call, whose
    // output goes through the same scanner as a file.
    const body = execFileSync('gh', ['pr', 'view', pr, '--json', 'body', '-q', '.body'], { encoding: 'utf8' });
    sources.push({ label: `pull request ${pr} body`, text: body });
  }
  const out = resolveMarkerFiles({ files, sources, ...roots, trackedPathRe: new RegExp(loaded.config.trackedPathPattern) });
  if (asJson) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    for (const r of out.rows) {
      process.stdout.write(`${r.status.padEnd(10)} ${r.file}:${r.line} ${r.marker} — ${r.message}\n`);
    }
    process.stdout.write(`${out.summary}\n`);
    if (out.counts.markers === 0) process.stdout.write('nothing was checked: no [r:…] marker in the inputs\n');
  }
  return out.exitCode;
}

// CLI entry is decided by `import.meta.main` (Node >= 24.2), as in
// check-push-ref.mjs: an exact URL comparison with argv[1] is FALSE through a
// directory junction, and the resolver would exit 0 in silence even on a
// MISMATCH.
if (!entryIsKnown(import.meta)) {
  process.stderr.write('resolve-run-figures: import.meta.main is unavailable (Node >= 24.2.0 required); refusing.\n');
  process.exitCode = 2;
} else if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
