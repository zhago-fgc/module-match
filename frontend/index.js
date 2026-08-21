import { loadCountries } from './countries.js';
import {
  participants,
  setPlayersRoster,
  findPlayerByName,
  renderParticipants,
  resetParticipants,
  clampToRanges,
  swapParticipants,
  loadGame,
} from './participants.js';

// The embed URL never changes with the skin pick anymore — it's
// /overlay/match (see server.ts), pasted into OBS/xSplit/vMix exactly once.
// That route resolves whichever pack is live off the `match-overlay` bus
// namespace on every request/reload, so picking a skin here only needs to
// write to that namespace, not hand out a different URL each time.
const OVERLAY_URL = new URL('/overlay/match', location.origin).href;
const embedUrlInput = document.getElementById('embed-url');
const skinSelect = document.getElementById('skin-select');
const overlayPreview = document.getElementById('overlay-preview');

embedUrlInput.value = OVERLAY_URL;
overlayPreview.src = OVERLAY_URL;

// Skins are user-imported overlay HTML/CSS/JS dropped into ZHAGO_DIR — not
// something the module ships, so this list is fetched at runtime rather than
// hardcoded. A module with none installed just shows the default option.
fetch('/api/overlays/match')
  .then((r) => r.json())
  .then((skins) => {
    for (const skin of skins) {
      const opt = document.createElement('option');
      opt.value = skin;
      opt.textContent = skin;
      skinSelect.appendChild(opt);
    }
  });

skinSelect.addEventListener('change', () => {
  fetch('/api/bus/match-overlay/set', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skin: skinSelect.value }),
  });
});

// One connection for both match's own data and its skin state, tagged by
// namespace — see GET /api/bus/stream in src/routes/bus.ts. `source.onmessage`
// is assigned further down, once the functions it needs are in scope.
// players is unconditionally in this namespace list, same as casters'
// caster-directory — if the module isn't installed, that namespace just
// never sends anything and the roster stays empty (suggestions only, never
// a hard requirement to type a player name).
const source = new EventSource('/api/bus/stream?ns=match,match-overlay,players');

const SIDES = [0, 1];

const gameSelect = document.getElementById('game-select');
const scoreDisplays = SIDES.map((i) => document.getElementById('side-' + i + '-score'));
const scoreUpButtons = SIDES.map((i) => document.getElementById('side-' + i + '-score-up'));
const scoreDownButtons = SIDES.map((i) => document.getElementById('side-' + i + '-score-down'));
const roundInput = document.getElementById('round');
const bestOfInput = document.getElementById('best-of');
const fromLosersInputs = SIDES.map((i) => document.getElementById('side-' + i + '-from-losers'));
const swapBtn = document.getElementById('swap-sides');
const clearBtn = document.getElementById('clear-match');

// Match never imports a game module — it discovers installed ones through
// the manifest registry (tags.includes('game')), same as any other module
// consuming another's data only through the bus.
//
// This fetch races the SSE snapshot below — on a fresh page load there's no
// guarantee /api/modules resolves before source.onmessage delivers the
// live state. If the snapshot wins, `gameSelect.value = targetGame` silently
// no-ops (there's no matching <option> yet) and the selection is lost. Null
// means "no state received yet" (leave the select alone); '' means "state
// arrived with no game selected" (a real value to apply).
let pendingGame = null;
fetch('/api/modules')
  .then((r) => r.json())
  .then((modules) => {
    for (const m of modules.filter((m) => m.tags?.includes('game'))) {
      const opt = document.createElement('option');
      opt.value = m.name;
      opt.textContent = m.name;
      gameSelect.appendChild(opt);
    }
    if (pendingGame !== null) gameSelect.value = pendingGame;
    if (modules.some((m) => m.name === 'countries')) {
      loadCountries(() => SIDES.forEach((i) => renderParticipants(i)));
    }
  });

// Live-managed fields not represented by any form control — score's own
// per-game log and the declared winner. Tracked here so "Update overlay"
// can echo them straight through instead of `set`'s full-object reset
// silently wiping them (they're not part of the staged form, so they'd
// otherwise fall back to `empty`'s defaults on every submit).
let liveWinner = null;
let liveGames = [];

gameSelect.addEventListener('change', () => {
  // Re-render both sides once the new game's ranges load — otherwise the
  // "+ Participant" button stays at whatever visibility the *previous*
  // game (or no game, unlimited) left it at.
  loadGame(gameSelect.value, () => {
    SIDES.forEach((i) => {
      clampToRanges(i);
      renderParticipants(i);
    });
  });
});

function sideValues(i) {
  return {
    fromLosers: fromLosersInputs[i].checked,
    participants: participants[i]
      .filter((p) => p.player.trim())
      .map((p) => ({ team: p.team, player: p.player, country: p.country, characters: p.characters })),
  };
}

// Toggle, not two separate actions — clicking the already-declared winner's
// button again unsets it (see the "Click again to unset" title), rather
// than needing a second dedicated button to find and click.
const winnerButtons = SIDES.map((i) => document.getElementById('side-' + i + '-winner'));
winnerButtons.forEach((btn, i) => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('active')) {
      fetch('/api/bus/match/unset-winner', { method: 'POST' });
      return;
    }
    fetch('/api/bus/match/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ winner: 'side-' + (i + 1) }),
    });
  });
});

// Immediate, not staged — same reasoning as the winner buttons. "+" logs a
// game win (snapshotting whichever characters are currently typed in) and
// bumps score; "-" undoes that side's most recent recorded game. Winner
// declaration stays a separate, manual step (see winnerButtons above) —
// this only tracks the running per-game log, never auto-completes the match.
scoreUpButtons.forEach((btn, i) => {
  btn.addEventListener('click', async () => {
    await publishForm(); // lock in whatever's currently typed before logging the game
    fetch('/api/bus/match/record-game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ winner: 'side-' + (i + 1) }),
    });
  });
});
scoreDownButtons.forEach((btn, i) => {
  btn.addEventListener('click', async () => {
    await publishForm();
    fetch('/api/bus/match/undo-game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ side: 'side-' + (i + 1) }),
    });
  });
});

// Local/unsaved-form-only — swaps what's currently typed in, same as any
// other field edit. Doesn't touch the live match until "Update overlay" is
// submitted, and doesn't touch an already-declared winner (that's live
// state, corrected separately by clicking that side's winner button again).
// The recorded game log's side references get flipped too — "side-1 won
// G2" means "whoever's in the side-1 slot," and swap changes who that is.
const otherSide = { 'side-1': 'side-2', 'side-2': 'side-1' };
swapBtn.addEventListener('click', () => {
  swapParticipants();
  [scoreDisplays[0].textContent, scoreDisplays[1].textContent] = [
    scoreDisplays[1].textContent,
    scoreDisplays[0].textContent,
  ];
  [fromLosersInputs[0].checked, fromLosersInputs[1].checked] = [
    fromLosersInputs[1].checked,
    fromLosersInputs[0].checked,
  ];
  if (liveWinner) liveWinner = otherSide[liveWinner];
  liveGames = liveGames.map((g) => ({
    winner: otherSide[g.winner],
    characters: { 'side-1': g.characters['side-2'] ?? [], 'side-2': g.characters['side-1'] ?? [] },
  }));
});

// Immediate, not staged — publishes an empty match right away (same shape
// `set` always resets to), rather than only clearing the form and leaving
// the previous match live on the overlay until "Update overlay" is clicked.
clearBtn.addEventListener('click', () => {
  fetch('/api/bus/match/set', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
});

// A player typed here that isn't already in the roster gets saved there too
// — same "don't fill the same form twice" reasoning as casters' commentator
// picker saving new names to caster-directory. Tracked across calls (not
// just within one) because publishForm() below now runs on every +/- click,
// not just "Update overlay" — without this, a name typed in but not yet
// echoed back by players' own SSE update could get a duplicate roster entry
// created on a second quick click before that roster refresh lands.
const attemptedPlayerNames = new Set();
async function saveNewPlayers() {
  const creates = SIDES.flatMap((i) => participants[i])
    .filter((p) => {
      const name = p.player.trim();
      if (!name || findPlayerByName(name) || attemptedPlayerNames.has(name.toLowerCase())) return false;
      attemptedPlayerNames.add(name.toLowerCase());
      return true;
    })
    .map((p) =>
      fetch('/api/bus/players/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: p.player.trim(), team: p.team || undefined, country: p.country || undefined }),
      }),
    );
  await Promise.all(creates);
}

function buildPayload() {
  return {
    game: gameSelect.value,
    round: roundInput.value,
    bestOf: Number(bestOfInput.value),
    // Echoed straight through, not read from any form control — see the
    // liveWinner/liveGames declaration for why `set`'s reset would otherwise
    // wipe them.
    winner: liveWinner,
    games: liveGames,
    sides: SIDES.map((i) => ({
      id: 'side-' + (i + 1),
      score: Number(scoreDisplays[i].textContent),
      ...sideValues(i),
    })),
  };
}

// Publishes whatever's currently in the form — shared by "Update overlay"
// and the score buttons above. The score buttons need this because
// record-game/undo-game read the *server's* current participants for the
// character snapshot; without publishing first, a name typed in but never
// submitted stays invisible to the server, and the match:update the score
// action triggers would echo that stale (or empty) server state straight
// back over this browser's own form.
async function publishForm() {
  await saveNewPlayers();
  await fetch('/api/bus/match/set', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildPayload()),
  });
}

document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await publishForm();
});

source.onmessage = (e) => {
  const msg = JSON.parse(e.data);

  if (msg.ns === 'match-overlay') {
    if (skinSelect.value !== msg.data.skin) skinSelect.value = msg.data.skin;
    return;
  }

  if (msg.ns === 'players') {
    setPlayersRoster(msg.data || []);
    return;
  }

  const state = msg.data;
  roundInput.value = state.round ?? '';
  bestOfInput.value = state.bestOf ?? 0;
  liveWinner = state.winner ?? null;
  liveGames = state.games ?? [];
  SIDES.forEach((i) => {
    const side = state.sides?.[i];
    scoreDisplays[i].textContent = side?.score ?? 0;
    fromLosersInputs[i].checked = !!side?.fromLosers;
    const isWinner = side && state.winner === side.id;
    winnerButtons[i].classList.toggle('active', !!isWinner);
    winnerButtons[i].textContent = isWinner ? 'Winner' : 'Declare winner';
  });

  const targetGame = state.game || '';
  pendingGame = targetGame;
  if (gameSelect.value !== targetGame) gameSelect.value = targetGame;
  loadGame(targetGame, () => {
    SIDES.forEach((i) => {
      const side = state.sides?.[i];
      resetParticipants(i, side?.participants || []);
    });
  });
};
