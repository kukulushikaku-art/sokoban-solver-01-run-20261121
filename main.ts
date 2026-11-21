// A deterministic Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// Idea: the levels are a 1-wide hallway with 1-4 rooms off it (3-4 boxes
// each). A box pushed out of a room into the hallway can never come back,
// so every room is an independent push-optimal problem; the level's optimum
// is the sum of the rooms' optima. The solver therefore
//   1. cuts the hallway row out of the floor graph; each connected component
//      holding boxes is one room, with a single door cell on the hallway;
//   2. solves each room on its own with A* over pushes (cost = pushes,
//      heuristic = the cheapest assignment of boxes to goals by shortest
//      walking distance, which is admissible), pruning dead squares (a box
//      that can never be pulled back onto a goal) and frozen 2x2 blocks,
//      and canonicalising the player by its reachable region so walking
//      never blows up the state space;
//   3. stitches the rooms together with shortest walks along the hallway.
//
// Deterministic: every budget is a count of expansions, never the clock.
// No clock, no environment (other than the input/output dir vars the kit's
// starter honours), no files outside /input, /output and /tmp. Node
// built-ins only, TypeScript erasable syntax only.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input \
//   MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Pushes, never the clock: the most A* states one room may pop, and the
// most the whole-level fallback may pop.
const MAX_ROOM_EXPANSIONS = 300_000;
const MAX_WHOLE_EXPANSIONS = 1_000_000;

const DIRS: [number, number, string][] = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parse(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outer frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/** The squares the player reaches from `from` around walls and `occ` boxes. */
function region(w: number, wall: Uint8Array, occ: Uint8Array, from: number): Uint8Array {
  const seen = new Uint8Array(wall.length);
  const stack = [from];
  seen[from] = 1;
  for (let i = 0; i < stack.length; i++) {
    const p = stack[i]!;
    for (const [dx, dy] of DIRS) {
      const q = p + dy * w + dx;
      if (!wall[q] && !occ[q] && !seen[q]) {
        seen[q] = 1;
        stack.push(q);
      }
    }
  }
  return seen;
}

function lowest(seen: Uint8Array): number {
  for (let i = 0; i < seen.length; i++) if (seen[i]) return i;
  return -1;
}

/** The shortest walk from `from` to `to` around walls and boxes, or null. */
function walkTo(
  w: number,
  wall: Uint8Array,
  occ: Uint8Array,
  from: number,
  to: number,
): string | null {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occ[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** Walking distance from `from` over floor alone (-1 where unreachable). */
function distances(w: number, wall: Uint8Array, from: number): Int32Array {
  const d = new Int32Array(wall.length).fill(-1);
  const queue = [from];
  d[from] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const q = p + dy * w + dx;
      if (!wall[q] && d[q] < 0) {
        d[q] = d[p]! + 1;
        queue.push(q);
      }
    }
  }
  return d;
}

/**
 * The squares a box can stand on and still be pushed onto some goal: pull
 * back from the goals over open floor. A box anywhere else is dead.
 */
function liveSquares(w: number, wall: Uint8Array, goals: number[]): Uint8Array {
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes with a box off its goal. */
function frozenBlock(
  w: number,
  wall: Uint8Array,
  occ: Uint8Array,
  goal: Uint8Array,
  t: number,
): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occ[a]) || !(wall[b] || occ[b]) || !(wall[c] || occ[c]) || !(wall[d] || occ[d])) continue;
    if ((occ[a] && !goal[a]) || (occ[b] && !goal[b]) || (occ[c] && !goal[c]) || (occ[d] && !goal[d])) return true;
  }
  return false;
}

interface PushSolution {
  pushes: number;
  moves: string;
  endPlayer: number;
}

/**
 * The push-optimal solution of one board: A* over pushes. A state is the
 * sorted boxes plus the player's reachable region (named by its lowest
 * square); a push costs 1 and the estimate is the cheapest assignment of
 * boxes to goals by walking distance (a Hungarian-style minimum over
 * permutations for a few boxes, a sum of nearest-goal distances for many).
 * Both are admissible, so the first solved state popped is optimal.
 * `exitCell` >= 0 requires the player to still reach that cell once the
 * boxes are on their goals (so it can leave the room); -1 asks for no exit.
 * Returns null when the search gives up (budget) or the level is unsolvable.
 */
function solvePushes(
  w: number,
  wall: Uint8Array,
  goals: number[],
  boxes0: number[],
  startPlayer: number,
  maxExpansions: number,
  exitCell: number,
): PushSolution | null {
  const size = wall.length;
  const n = boxes0.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(w, wall, goals);
  if (boxes0.some((b) => !live[b])) return null;
  const distGoal = goals.map((g) => distances(w, wall, g));
  const base = 256 ** n;

  // All orders of the goals, for the assignment estimate (n <= 5 only).
  const perms: number[][] =
    n <= 5
      ? (() => {
          const out: number[][] = [];
          const cur: number[] = [];
          const used = new Array(n).fill(false);
          const rec = (): void => {
            if (cur.length === n) {
              out.push(cur.slice());
              return;
            }
            for (let i = 0; i < n; i++) {
              if (used[i]) continue;
              used[i] = true;
              cur.push(i);
              rec();
              cur.pop();
              used[i] = false;
            }
          };
          rec();
          return out;
        })()
      : [];

  const estimate = (boxes: number[]): number => {
    if (n <= 5) {
      let best = Infinity;
      for (const p of perms) {
        let sum = 0;
        let ok = true;
        for (let i = 0; i < n; i++) {
          const d = distGoal[p[i]!]![boxes[i]!]!;
          if (d < 0) {
            ok = false;
            break;
          }
          sum += d;
        }
        if (ok && sum < best) best = sum;
      }
      return best;
    }
    let sum = 0;
    for (const b of boxes) {
      let m = Infinity;
      for (let gi = 0; gi < n; gi++) {
        const d = distGoal[gi]![b]!;
        if (d >= 0 && d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      sum += m;
    }
    return sum;
  };

  const pack = (boxes: number[]): number => {
    let p = 0;
    for (const b of boxes) p = p * 256 + b;
    return p;
  };
  const unpack = (p: number): number[] => {
    const out = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      out[i] = p % 256;
      p = Math.floor(p / 256);
    }
    return out;
  };
  const keyOf = (boxes: number[], low: number): number => low * base + pack(boxes);

  // The states, in the order found: packed boxes, the player's square, the
  // parent, and the push that made the state from its parent.
  const sPack: number[] = [];
  const sPlayer: number[] = [];
  const sParent: number[] = [];
  const sFrom: number[] = [];
  const sTo: number[] = [];
  const sDir: number[] = [];
  const sG: number[] = [];
  const sF: number[] = [];
  const sKey: number[] = [];
  const closed = new Map<number, number>();

  // The open list: a binary heap of state ids on (f, -g, id).
  const heap: number[] = [];
  const less = (a: number, b: number): boolean =>
    sF[a]! < sF[b]! || (sF[a]! === sF[b]! && (sG[a]! > sG[b]! || (sG[a]! === sG[b]! && a < b)));
  const heapPush = (id: number): void => {
    let i = heap.length;
    heap.push(id);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  const addState = (
    boxes: number[],
    player: number,
    parent: number,
    from: number,
    to: number,
    dir: number,
    g: number,
    key: number,
  ): number => {
    const id = sPack.length;
    sPack.push(pack(boxes));
    sPlayer.push(player);
    sParent.push(parent);
    sFrom.push(from);
    sTo.push(to);
    sDir.push(dir);
    sG.push(g);
    sF.push(g + estimate(boxes));
    sKey.push(key);
    closed.set(key, g);
    heapPush(id);
    return id;
  };

  const occOf = (boxes: number[]): Uint8Array => {
    const occ = new Uint8Array(size);
    for (const b of boxes) occ[b] = 1;
    return occ;
  };

  const startOcc = occOf(boxes0);
  const startKey = keyOf(boxes0, lowest(region(w, wall, startOcc, startPlayer)));
  addState(boxes0, startPlayer, -1, -1, -1, -1, 0, startKey);

  let expansions = 0;
  let found = -1;
  while (heap.length > 0 && expansions < maxExpansions) {
    const id = heapPop();
    if (closed.get(sKey[id]!) !== sG[id]!) continue; // a better path to this state was found
    const boxes = unpack(sPack[id]!);
    if (boxes.every((b) => goal[b])) {
      if (exitCell < 0) {
        found = id;
        break;
      }
      const occ = occOf(boxes);
      if (region(w, wall, occ, sPlayer[id]!)[exitCell]) {
        found = id;
        break;
      }
      continue; // solved but the player cannot leave: keep looking
    }
    expansions++;
    const occ = occOf(boxes);
    const reach = region(w, wall, occ, sPlayer[id]!);
    const g = sG[id]!;
    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi]!;
      for (let k = 0; k < 4; k++) {
        const [dx, dy] = DIRS[k]!;
        const d = dy * w + dx;
        const t = b + d;
        const s = b - d;
        if (!reach[s] || wall[t] || occ[t] || !live[t]) continue;
        const next = boxes.slice();
        next[bi] = t;
        next.sort((a, bb) => a - bb);
        occ[b] = 0;
        occ[t] = 1;
        const frozen = frozenBlock(w, wall, occ, goal, t);
        let key = -1;
        if (!frozen) key = keyOf(next, lowest(region(w, wall, occ, b)));
        occ[t] = 0;
        occ[b] = 1;
        if (frozen) continue;
        const g2 = g + 1;
        const prev = closed.get(key);
        if (prev !== undefined && prev <= g2) continue;
        if (estimate(next) === Infinity) continue;
        addState(next, b, id, b, t, k, g2, key);
      }
    }
  }
  if (found < 0) return null;

  // The path of pushes, then the moves: walk to each push's square, push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = startPlayer;
  let boxes = boxes0.slice();
  for (const s of path) {
    const from = sFrom[s]!;
    const to = sTo[s]!;
    const dir = sDir[s]!;
    const [dx, dy, letter] = DIRS[dir]!;
    const d = dy * w + dx;
    const pushFrom = from - d;
    const occ = occOf(boxes);
    const walk = walkTo(w, wall, occ, player, pushFrom);
    if (walk === null) return null; // cannot happen: the push square was reachable
    moves += walk + letter;
    player = from;
    boxes = boxes.map((b) => (b === from ? to : b));
    boxes.sort((a, b) => a - b);
  }
  return { pushes: path.length, moves, endPlayer: player };
}

interface Room {
  cells: number[];
  boxes: number[];
  goals: number[];
  door: number;
  top: number;
  left: number;
}

/** The rooms of a level: cut the hallway row out of the floor graph. */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const hallRow = Math.floor(player / w);
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || Math.floor(s / w) === hallRow || part[s] >= 0) continue;
    const cells = [s];
    part[s] = rooms.length;
    for (let i = 0; i < cells.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = cells[i]! + dy * w + dx;
        if (!wall[q] && Math.floor(q / w) !== hallRow && part[q] < 0) {
          part[q] = rooms.length;
          cells.push(q);
        }
      }
    }
    rooms.push({ cells, boxes: [], goals: [], door: -1, top: 0, left: 0 });
  }
  for (const b of boxes) {
    if (Math.floor(b / w) === hallRow) return null; // a box in the hallway: no rooms
    rooms[part[b]!]!.boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  const out: Room[] = [];
  for (const r of rooms) {
    if (r.boxes.length === 0) continue;
    if (r.boxes.length !== r.goals.length) return null;
    // The door: the hallway cell next to a room cell (there is exactly one).
    let door = -1;
    for (const cell of r.cells) {
      for (const [dx, dy] of DIRS) {
        const q = cell + dy * w + dx;
        if (Math.floor(q / w) === hallRow && !wall[q]) door = q;
      }
    }
    if (door < 0) return null;
    r.door = door;
    let top = Infinity;
    let left = Infinity;
    for (const c of r.cells) {
      top = Math.min(top, Math.floor(c / w));
      left = Math.min(left, c % w);
    }
    r.top = top;
    r.left = left;
    r.boxes.sort((a, b) => a - b);
    r.goals.sort((a, b) => a - b);
    out.push(r);
  }
  out.sort((a, b) => a.top - b.top || a.left - b.left);
  return out;
}

/** The whole level, room by room; null when a room cannot be solved. */
function solveByRooms(level: Level): string | null {
  const rooms = roomsOf(level);
  if (rooms === null || rooms.length === 0) return null;
  // Each room is independent of the others, so solve them all first; a room
  // whose player cannot leave after it is done goes last.
  const solved: { room: Room; sol: PushSolution; exit: boolean }[] = [];
  for (const room of rooms) {
    const subWall = new Uint8Array(level.wall.length).fill(1);
    for (const c of room.cells) subWall[c] = 0;
    subWall[room.door] = 0;
    const withExit = solvePushes(
      level.w,
      subWall,
      room.goals,
      room.boxes,
      room.door,
      MAX_ROOM_EXPANSIONS,
      room.door,
    );
    if (withExit !== null) {
      solved.push({ room, sol: withExit, exit: true });
      continue;
    }
    const noExit = solvePushes(
      level.w,
      subWall,
      room.goals,
      room.boxes,
      room.door,
      MAX_ROOM_EXPANSIONS,
      -1,
    );
    if (noExit === null) return null;
    solved.push({ room, sol: noExit, exit: false });
  }
  const noExitCount = solved.filter((s) => !s.exit).length;
  if (noExitCount > 1) return null; // only the last room may trap the player
  solved.sort((a, b) => Number(b.exit) - Number(a.exit));

  const occOf = (boxes: number[]): Uint8Array => {
    const occ = new Uint8Array(level.wall.length);
    for (const b of boxes) occ[b] = 1;
    return occ;
  };
  let player = level.player;
  let boxes = level.boxes.slice();
  let moves = '';
  for (let ri = 0; ri < solved.length; ri++) {
    const { room, sol } = solved[ri]!;
    const toDoor = walkTo(level.w, level.wall, occOf(boxes), player, room.door);
    if (toDoor === null) return null;
    moves += toDoor;
    moves += sol.moves;
    boxes = boxes.filter((b) => !room.boxes.includes(b)).concat(room.goals);
    player = sol.endPlayer;
    if (ri < solved.length - 1) {
      const out = walkTo(level.w, level.wall, occOf(boxes), player, room.door);
      if (out === null) return null;
      moves += out;
      player = room.door;
    }
  }
  return moves;
}

/** The whole level as one push problem (the fallback when it has no rooms). */
function solveWhole(level: Level): string | null {
  const sol = solvePushes(
    level.w,
    level.wall,
    level.goals,
    level.boxes,
    level.player,
    MAX_WHOLE_EXPANSIONS,
    -1,
  );
  return sol === null ? null : sol.moves;
}

function solve(text: string): string {
  const level = parse(text);
  if (level.boxes.length === 0) return '';
  return solveByRooms(level) ?? solveWhole(level) ?? '';
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
