import type { ModuleContext } from '@zhago/types';

// Live match state — same pattern as the casters module: the cockpit form
// sets it, the overlay renders it, nothing persists (it's "what's happening
// right now," not reference data — that's Directory-shaped modules' job).
//
// `game` names an installed game module (e.g. "2xko"), which Match never
// imports or calls directly — the cockpit queries that module's own bus
// stream for its roster and declared ranges. A side is a `participants[]`
// list rather than fixed `player1Name`/`player2Name` fields or flat
// `players[]`/`characters[]` arrays, because a flat pairing can't express
// who's playing what: a 2XKO duo side might have FLY's SonicFox on Senna
// and SHR's INZEM on Teemo — two different orgs, one side. `team` lives only
// on Participant, not Side — a side isn't one org, a player is.
//
// `characters` per participant, not per side, is what lets a solo 2XKO
// player run two characters (both in one participant) while a duo splits
// one each (two participants) — no game-specific split rule is enforced
// here; the cockpit just bounds total side characters against
// charactersPerSide.max and lets the TO assign them correctly by hand.
// Fixed at two sides — no current game needs more than that; revisit if
// one does. Match works exactly the same with `game` left empty (no
// characters on any participant, `team` stays free text either way).
interface Participant {
  player: string;
  team: string;
  country: string;
  characters: string[];
}

interface Side {
  id: string;
  score: number;
  participants: Participant[];
  // Marks a side as the losers-bracket entrant in a Grand Finals bracket
  // reset — optional and independent per side (not a forced single-select)
  // since most rounds aren't a bracket reset at all, and there's no rule
  // enforced here that exactly one side must be marked.
  fromLosers: boolean;
}

// One entry per individual game within the match (not the match's final
// aggregate) — `characters` is a snapshot of whichever characters each side
// had selected at the moment that game was recorded, since a player can
// swap character between games within the same set. Keyed by side id, not
// per-participant — a duo side's per-participant game-by-game attribution
// isn't tracked at this granularity; only the match-level Participant.characters
// union has that.
interface GameResult {
  winner: string;
  characters: Record<string, string[]>;
}

interface MatchState {
  game: string;
  round: string;
  bestOf: number;
  sides: [Side, Side];
  games: GameResult[];
  // A side's `id`, or null while the match is still in progress. Only ever
  // set by 'complete' — a manual TO action, deliberately not automatic even
  // once a side's score reaches bestOf's threshold (a forfeit, a bracket
  // reset, or just bad manual scorekeeping shouldn't force a completion the
  // TO didn't actually declare). match-history listens for this going from
  // null to non-null as its one and only "record this match" signal.
  winner: string | null;
}

function emptySide(id: string): Side {
  return { id, score: 0, participants: [], fromLosers: false };
}

const empty: MatchState = {
  game: '',
  round: '',
  bestOf: 3,
  sides: [emptySide('side-1'), emptySide('side-2')],
  games: [],
  winner: null,
};

// Which overlay pack is live right now — deliberately its own namespace, not
// a field on MatchState. `match:set`'s handler below does a full
// `{ ...empty, ...payload }` reset on every submit, so a score/round update
// with no `skin` in its payload would silently snap the live overlay back to
// default if this lived on the same state. Kept separate so picking a pack
// and updating the score are independent operations.
interface OverlayState {
  skin: string;
}

const emptyOverlay: OverlayState = { skin: '' };

export default function init(ctx: ModuleContext) {
  let current: MatchState = empty;
  let overlay: OverlayState = emptyOverlay;

  ctx.on('match', 'set', (payload: Partial<MatchState>) => {
    current = { ...empty, ...payload };
    ctx.emit('match', 'update', current);
  });

  // Distinct from 'set'/'update' on purpose — a score edit looks identical to
  // a match finishing if you're just diffing state, so this is its own
  // explicit signal. Emits both 'update' (existing listeners see the winner)
  // and 'complete' (match-history's specific trigger to record a snapshot).
  // Idempotent on purpose — a double-click, a retried POST, or any other
  // duplicate call with the same winner is a no-op rather than a second
  // match-history record for the same completion.
  ctx.on('match', 'complete', ({ winner }: { winner: string }) => {
    if (current.winner === winner) return;
    if (!current.sides.some((s) => s.id === winner)) return;
    current = { ...current, winner };
    ctx.emit('match', 'update', current);
    ctx.emit('match', 'complete', current);
  });

  // Winner declaration stays manual (see 'complete' above) — this only logs
  // which game was won by whom and with what characters, and bumps that
  // side's score to match. Snapshots whichever characters are on each
  // participant right now, since a swap happens between games, not during one.
  ctx.on('match', 'record-game', ({ winner }: { winner: string }) => {
    if (current.winner) return; // match already decided — no more games to log
    if (!current.sides.some((s) => s.id === winner)) return;

    const characters: Record<string, string[]> = {};
    for (const side of current.sides) characters[side.id] = side.participants.flatMap((p) => p.characters);

    current = {
      ...current,
      games: [...current.games, { winner, characters }],
      sides: current.sides.map((s) => (s.id === winner ? { ...s, score: s.score + 1 } : s)) as [Side, Side],
    };
    ctx.emit('match', 'update', current);
  });

  // Undoes this side's most recent recorded game (not necessarily the very
  // last game overall) — a per-side "-" button corrects that side's count
  // without needing to know or care what the other side's last game was.
  ctx.on('match', 'undo-game', ({ side }: { side: string }) => {
    const idx = current.games.map((g) => g.winner).lastIndexOf(side);
    if (idx === -1) return;

    current = {
      ...current,
      games: current.games.filter((_, i) => i !== idx),
      sides: current.sides.map((s) =>
        s.id === side ? { ...s, score: Math.max(0, s.score - 1) } : s,
      ) as [Side, Side],
    };
    ctx.emit('match', 'update', current);
  });

  // Corrects a misclick — clears the live winner so the overlay stops
  // showing one and the TO can re-declare. Never touches match-history: that
  // record already reflects what was genuinely declared complete at the
  // time, and match-history reacts to match, never the other way around
  // (see its own 'delete' action if the record itself needs correcting).
  ctx.on('match', 'unset-winner', () => {
    if (!current.winner) return;
    current = { ...current, winner: null };
    ctx.emit('match', 'update', current);
  });

  // Answered by the SSE route on connect, before it subscribes to live 'update's.
  ctx.on('match', 'get-current', ({ replyTopic }: { replyTopic: string }) => {
    ctx.emit('reply', replyTopic, current);
  });

  // The overlay (modules/match/overlay/index.js) watches this to know which
  // skin to load live — `skin: ''` means the shipped default.
  ctx.on('match-overlay', 'set', (payload: Partial<OverlayState>) => {
    overlay = { ...emptyOverlay, ...payload };
    ctx.emit('match-overlay', 'update', overlay);
  });

  ctx.on('match-overlay', 'get-current', ({ replyTopic }: { replyTopic: string }) => {
    ctx.emit('reply', replyTopic, overlay);
  });

  ctx.log.info('ready');
}
