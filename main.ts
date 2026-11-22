// mend: applies an AI-written edit, in any of the four formats SPEC.md
// describes, to a tree of text files. Every edit runs against an in-memory
// copy of the tree; the real files are written only when no edit failed,
// so a patch changes everything or nothing. Matching is tried at three
// tiers (exact, trailing-whitespace-insensitive, fully trim-insensitive)
// and the first tier that matches anywhere wins. Node 22, stdlib only.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): that
// hand-over and runner.ts stay exactly as the kit ships them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];
const DEVNULL = Symbol('devnull');
type PathValue = string | typeof DEVNULL | undefined;

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';
const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}
function needSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

interface SplitFile {
  lines: string[];
  br: string;
  final: boolean;
}
function splitFile(text: string): SplitFile {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}
function joinFile(f: SplitFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}
function textOf(lines: string[], final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (final ? '\n' : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---------- section 5: matching lines ----------

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}
function occurrences(lines: string[], old: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + old.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < old.length; k += 1) {
      if (!lineEq(lines[i + k]!, old[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
interface TierHit {
  tier: number;
  at: number[];
}
function findTier(lines: string[], old: string[], strict: boolean, from: number, eofOnly = false): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    let at = occurrences(lines, old, tier, from);
    if (eofOnly) at = at.filter((i) => i + old.length === lines.length);
    if (at.length > 0) return { tier, at };
  }
  return null;
}
function reindent(line: string, tier: number, fileLead: string, oldLead: string): string {
  if (tier !== 2) return line;
  if (line === '' || line.trim() === '') return line;
  if (line.startsWith(oldLead)) return fileLead + line.slice(oldLead.length);
  return line;
}
interface BodyItem {
  kind: string; // ' ' context, '-' old, '+' new, '\\' marker
  text: string;
}
function oldOf(items: BodyItem[]): string[] {
  return items.filter((b) => b.kind === ' ' || b.kind === '-').map((b) => b.text);
}
function newCount(items: BodyItem[]): number {
  return items.filter((b) => b.kind === ' ' || b.kind === '+').length;
}
/** Replace lines[pos .. pos+oldLen) by the segment the body items describe. */
function applyItems(lines: string[], items: BodyItem[], pos: number, tier: number, old: string[]): string[] {
  const fileLead = old.length > 0 ? leadWs(lines[pos] ?? '') : '';
  const oldLead = old.length > 0 ? leadWs(old[0]!) : '';
  const seg: string[] = [];
  let oi = 0;
  for (const b of items) {
    if (b.kind === ' ') {
      seg.push(lines[pos + oi]!);
      oi += 1;
    } else if (b.kind === '-') {
      oi += 1;
    } else if (b.kind === '+') {
      seg.push(reindent(b.text, tier, fileLead, oldLead));
    }
  }
  return [...lines.slice(0, pos), ...seg, ...lines.slice(pos + old.length)];
}
/** Whether a `\` marker directly follows the body's last context or `+` line. */
function backslashAfterLastWrite(items: BodyItem[]): boolean {
  let last = -1;
  items.forEach((b, idx) => {
    if (b.kind === ' ' || b.kind === '+') last = idx;
  });
  return last >= 0 && items[last + 1]?.kind === '\\';
}

// ---------- section 4: detecting the format ----------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- section 6: unified diffs ----------

interface Hunk {
  a: number;
  items: BodyItem[];
}
interface Section {
  gitOld: PathValue;
  gitNew: PathValue;
  headOld: PathValue;
  headNew: PathValue;
  renameFrom: PathValue;
  renameTo: PathValue;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}
function newSection(): Section {
  return { gitOld: undefined, gitNew: undefined, headOld: undefined, headNew: undefined, renameFrom: undefined, renameTo: undefined, isNew: false, isDeleted: false, hunks: [] };
}
function headerPath(raw: string): PathValue {
  const tab = raw.indexOf('\t');
  const cut = (tab >= 0 ? raw.slice(0, tab) : raw).trim();
  if (cut === '/dev/null') return DEVNULL;
  if (cut.startsWith('a/') || cut.startsWith('b/')) return cut.slice(2);
  return cut;
}
function gitPaths(line: string, lineNo: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${lineNo}`);
  const sep = rest.indexOf(' b/', 2);
  if (sep < 0) throw new Exit2(`error: parse ${lineNo}`);
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${lineNo}`);
  return [x, y];
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let hunk: Hunk | null = null;
  const flushHunk = (): void => {
    if (hunk !== null && cur !== null) {
      while (hunk.items.length > 0) {
        const last = hunk.items[hunk.items.length - 1]!;
        if (last.kind === ' ' && last.text === '') hunk.items.pop();
        else break;
      }
      cur.hunks.push(hunk);
    }
    hunk = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const no = i + 1;
    const nextIsPlus = (lines[i + 1] ?? '').startsWith('+++ ');
    // A hunk body swallows its own lines before anything else is read.
    if (hunk !== null) {
      const c0 = line[0];
      const isBody = line === '' || c0 === ' ' || c0 === '-' || c0 === '+' || c0 === '\\';
      const endsBody = line.startsWith('diff --git ') || (line.startsWith('--- ') && nextIsPlus);
      if (isBody && !endsBody) {
        if (line === '') hunk.items.push({ kind: ' ', text: '' });
        else hunk.items.push({ kind: c0!, text: line.slice(1) });
        i += 1;
        continue;
      }
      flushHunk();
    }
    if (line.startsWith('diff --git ')) {
      const [x, y] = gitPaths(line, no);
      cur = newSection();
      cur.gitOld = x;
      cur.gitNew = y;
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (nextIsPlus) {
        const oldP = headerPath(line.slice(4));
        const newP = headerPath(lines[i + 1]!.slice(4));
        if (cur !== null && inHeader && cur.headOld === undefined) {
          cur.headOld = oldP;
          cur.headNew = newP;
        } else {
          cur = newSection();
          cur.headOld = oldP;
          cur.headNew = newP;
          sections.push(cur);
          inHeader = true;
        }
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${no + 1}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${no}`);
      inHeader = false;
      hunk = { a: Number(m[1]), items: [] };
      i += 1;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDeleted = true;
    }
    i += 1;
  }
  flushHunk();
  return sections;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((sec) => (tree: Tree) => {
    let oldP: PathValue = sec.headOld !== undefined ? sec.headOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld;
    let newP: PathValue = sec.headNew !== undefined ? sec.headNew : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew;
    const creation = oldP === DEVNULL || sec.isNew;
    const deletion = newP === DEVNULL || sec.isDeleted;
    if (creation) {
      const p = newP as string;
      needSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastPlusBackslash = false;
      for (const h of sec.hunks) {
        h.items.forEach((b, idx) => {
          if (b.kind === '+') {
            plus.push(b.text);
            lastPlusBackslash = h.items[idx + 1]?.kind === '\\';
          }
        });
      }
      tree.now.set(p, textOf(plus, plus.length > 0 && !lastPlusBackslash));
      return;
    }
    if (deletion) {
      const p = oldP as string;
      needSafe(p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const o = oldP as string;
    const n = newP as string;
    needSafe(o);
    if (n !== o) needSafe(n);
    const before = tree.get(o);
    if (before === null) throw new Fail('missing', o);
    if (n !== o && tree.get(n) !== null) throw new Fail('exists', n);
    const f = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const old = oldOf(h.items);
      if (old.length === 0) {
        const pos = Math.min(Math.max(h.a + d, 0), f.lines.length);
        const atEnd = pos === f.lines.length;
        const added = h.items.filter((b) => b.kind === '+').map((b) => b.text);
        f.lines = [...f.lines.slice(0, pos), ...added, ...f.lines.slice(pos)];
        if (atEnd) f.final = !backslashAfterLastWrite(h.items);
        d += added.length;
        continue;
      }
      const hit = findTier(f.lines, old, strict, 0);
      if (hit === null) throw new Fail('no-match', o);
      const target = h.a - 1 + d;
      let pos = hit.at[0]!;
      for (const cand of hit.at) {
        if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
      }
      const runsToEnd = pos + old.length === f.lines.length;
      f.lines = applyItems(f.lines, h.items, pos, hit.tier, old);
      if (runsToEnd) f.final = !backslashAfterLastWrite(h.items);
      d += newCount(h.items) - old.length;
    }
    const out = joinFile(f);
    if (n !== o) {
      tree.now.set(o, null);
      tree.now.set(n, out);
      tree.moves.push([o, n]);
    } else {
      tree.now.set(o, out);
    }
  });
}

// ---------- section 7: SEARCH/REPLACE blocks ----------

interface Block {
  path: string;
  oldLines: string[];
  newLines: string[];
}
function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchNo = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchNo}`);
    let path: string | null = null;
    for (let k = i - 1; k > prevEnd; k -= 1) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchNo}`);
      path = prevPath;
    }
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks;
}
function blockEdits(lines: string[], strict: boolean): Edit[] {
  const blocks = parseBlocks(lines);
  return blocks.map((b) => (tree: Tree) => {
    needSafe(b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, textOf(b.newLines, b.newLines.length > 0));
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const f = splitFile(before);
    const hit = findTier(f.lines, b.oldLines, strict, 0);
    if (hit === null) throw new Fail('no-match', b.path);
    if (hit.at.length > 1) throw new Fail('ambiguous', b.path);
    const items: BodyItem[] = [
      ...b.oldLines.map((t) => ({ kind: '-', text: t })),
      ...b.newLines.map((t) => ({ kind: '+', text: t })),
    ];
    f.lines = applyItems(f.lines, items, hit.at[0]!, hit.tier, b.oldLines);
    tree.now.set(b.path, joinFile(f));
  });
}

// ---------- section 8: V4A patches ----------

interface Chunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  moveTo: string | null;
  addLines: string[];
  chunks: Chunk[];
}
function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isHeader = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (!isHeader(line)) throw new Exit2(`error: parse ${i + 1}`);
    const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'delete' : 'update';
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const sec: VSection = { kind, path: line.slice(prefix.length).trim(), lineNo: i + 1, moveTo: null, addLines: [], chunks: [] };
    sections.push(sec);
    i += 1;
    if (kind === 'add') {
      const raw: string[] = [];
      while (i < last && !isHeader(lines[i]!) && lines[i]!.trim() !== '*** End Patch') {
        const l = lines[i]!;
        if (l.startsWith('+')) raw.push(l.slice(1));
        else if (l === '') raw.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      sec.addLines = raw;
      continue;
    }
    if (kind === 'delete') {
      let j = i;
      while (j < last && blank(lines[j]!)) j += 1;
      if (j < last && !isHeader(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
      i = j;
      continue;
    }
    // update
    if (i < last && lines[i]!.startsWith('*** Move to: ')) {
      sec.moveTo = lines[i]!.slice('*** Move to: '.length).trim();
      i += 1;
    }
    let chunk: Chunk | null = null;
    const flushChunk = (): void => {
      if (chunk !== null) {
        while (chunk.items.length > 0) {
          const tail = chunk.items[chunk.items.length - 1]!;
          if (tail.kind === ' ' && tail.text === '') chunk.items.pop();
          else break;
        }
        sec.chunks.push(chunk);
      }
      chunk = null;
    };
    while (i < last) {
      const l = lines[i]!;
      if (isHeader(l)) break;
      if (l.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${i + 1}`);
      if (l.trimEnd() === '*** End of File') {
        if (chunk === null) chunk = { anchor: null, eof: true, items: [] };
        chunk.eof = true;
        flushChunk();
        i += 1;
        continue;
      }
      if (l.startsWith('*** ')) throw new Exit2(`error: parse ${i + 1}`);
      if (l.startsWith('@@')) {
        flushChunk();
        const anchor = l.slice(2).trim();
        chunk = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
        i += 1;
        continue;
      }
      const c0 = l[0];
      if (l === '' || c0 === ' ' || c0 === '-' || c0 === '+') {
        if (chunk === null) chunk = { anchor: null, eof: false, items: [] };
        if (l === '') chunk.items.push({ kind: ' ', text: '' });
        else chunk.items.push({ kind: c0!, text: l.slice(1) });
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    flushChunk();
    if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
  }
  return sections;
}
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseV4a(lines);
  return sections.map((sec) => (tree: Tree) => {
    needSafe(sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, textOf(sec.addLines, sec.addLines.length > 0));
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null) needSafe(sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let found = -1;
        for (const tier of tiers) {
          for (let k = cursor; k < f.lines.length; k += 1) {
            if (lineEq(f.lines[k]!, ch.anchor, tier)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', sec.path);
        cursor = found + 1;
      }
      const old = oldOf(ch.items);
      if (old.length === 0) {
        const pos = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        const added = ch.items.filter((b) => b.kind === '+').map((b) => b.text);
        f.lines = [...f.lines.slice(0, pos), ...added, ...f.lines.slice(pos)];
        cursor = pos + added.length;
        continue;
      }
      const hit = findTier(f.lines, old, strict, cursor, ch.eof);
      if (hit === null) throw new Fail('no-match', sec.path);
      const pos = hit.at[0]!;
      f.lines = applyItems(f.lines, ch.items, pos, hit.tier, old);
      cursor = pos + newCount(ch.items);
    }
    const out = joinFile(f);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, out);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, out);
    }
  });
}

// ---------- section 9: JSON edits ----------

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- sections 1, 2 and 10: the CLI itself ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = blockEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Changed paths, with a successful move shown as one R line sorted by its new path.
  const bySort = new Map<string, string>();
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (movedOld.has(o) || movedNew.has(n)) continue;
    if (tree.original(o) === null || tree.now.get(o) !== null) continue;
    if (tree.original(n) !== null || tree.now.get(n) === null) continue;
    movedOld.add(o);
    movedNew.add(n);
    bySort.set(n, `R ${o} -> ${n}`);
  }
  for (const p of tree.now.keys()) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    bySort.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  const rows = [...bySort.entries()].sort((x, y) => Buffer.compare(Buffer.from(x[0]), Buffer.from(y[0]))).map(([, v]) => v);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
