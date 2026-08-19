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
}

interface MatchState {
  game: string;
  round: string;
  bestOf: number;
  sides: [Side, Side];
}

function emptySide(id: string): Side {
  return { id, score: 0, participants: [] };
}

const empty: MatchState = {
  game: '',
  round: '',
  bestOf: 3,
  sides: [emptySide('side-1'), emptySide('side-2')],
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
