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
const source = new EventSource('/api/bus/stream?ns=match,match-overlay');

const SIDES = [0, 1];

const gameSelect = document.getElementById('game-select');
const scoreInputs = SIDES.map((i) => document.getElementById('side-' + i + '-score'));
const participantContainers = SIDES.map((i) =>
  document.getElementById('side-' + i + '-participants'),
);
const addParticipantButtons = SIDES.map((i) =>
  document.getElementById('side-' + i + '-add-participant'),
);
const roundInput = document.getElementById('round');
const bestOfInput = document.getElementById('best-of');

// Match never imports a game module — it discovers installed ones through
// the manifest registry (tags.includes('game')), same as any other module
// consuming another's data only through the bus.
fetch('/api/modules')
  .then((r) => r.json())
  .then((modules) => {
    for (const m of modules.filter((m) => m.tags?.includes('game'))) {
      const opt = document.createElement('option');
      opt.value = m.name;
      opt.textContent = m.name;
      gameSelect.appendChild(opt);
    }
  });

let gameData = null; // { characters, charactersPerSide, playersPerSide, ... } from the selected game module

// No format list gating this — a game just declares how many characters (or
// players) a side needs as a {min, max} range (2xko: characters fixed at 2,
// players 1-2 for solo/duo; sf6: both fixed at 1; kofxv: characters fixed at
// 3, players fixed at 1), and the cockpit adds/removes slots within that
// range instead of offering a menu of named shapes to pick between. A game
// that doesn't declare a range at all is treated as fully freeform — {1,
// Infinity} — rather than forcing every game author to opt in just to get
// today's default behavior.
function charRange() {
  return gameData?.charactersPerSide ?? { min: 1, max: Infinity };
}

function playerRange() {
  return gameData?.playersPerSide ?? { min: 1, max: Infinity };
}

// One participant = one team + one player + their character(s). A side is
// participants[], not flat players[]/characters[] arrays, because a flat
// pairing can't express a cross-org duo (2XKO: FLY's SonicFox on Senna +
// SHR's INZEM on Teemo, one side, two different teams). `charactersPerSide`
// bounds the SIDE's total across every participant, not each participant
// individually — no game-specific split rule (e.g. "2XKO duo splits 1 each")
// is enforced here; the TO assigns characters to whichever participant
// actually plays them.
const participants = SIDES.map(() => []);

function totalCharacters(i) {
  return participants[i].reduce((sum, p) => sum + p.characters.length, 0);
}

// charactersPerSide bounds the whole side, not each participant — after any
// add/remove, every *other* participant's chip box on this side needs to
// re-check its own atMax too, or a sibling's box goes stale (still shows
// "Add character…" and accepts typing even though the side is already full).
function refreshSiblingChips(i, skipPIdx) {
  participantContainers[i].querySelectorAll('.combobox').forEach((chipField, pIdx) => {
    if (pIdx !== skipPIdx) renderParticipantChips(i, pIdx, chipField);
  });
}

// Called after a game switch, before re-rendering — a duo's 2 participants
// (or a side's characters) can be over the *new* game's limits if the
// previous game allowed more.
function clampToRanges(i) {
  const pMax = playerRange().max;
  if (participants[i].length > pMax) participants[i] = participants[i].slice(0, pMax);

  let remaining = charRange().max;
  for (const p of participants[i]) {
    if (p.characters.length > remaining)
      p.characters = p.characters.slice(0, Math.max(remaining, 0));
    remaining -= p.characters.length;
  }
}

// Character chip/tag combobox — GitHub-labels-style. One always-visible text
// input per participant instead of a <select> per character slot, which
// stopped scaling once a game needed 3-4 characters a side (Marvel Tokon).
// Re-renders (only this participant's chip box, not the whole participant
// list) on every change instead of diffing the DOM. The suggestions-list
// wiring itself is the shared zhagoCombobox() (see /assets/combobox.js) —
// this only owns what's chip-specific: multiple values, Enter-to-commit,
// Backspace-to-remove-last.
function renderParticipantChips(i, pIdx, container) {
  const participant = participants[i][pIdx];
  container.innerHTML = '';

  const atMax = totalCharacters(i) >= charRange().max;

  const box = document.createElement('div');
  box.className = 'chip-box';

  participant.characters.forEach((name, cIdx) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'chip-remove';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      participant.characters.splice(cIdx, 1);
      renderParticipantChips(i, pIdx, container);
      refreshSiblingChips(i, pIdx);
    });
    chip.appendChild(remove);
    box.appendChild(chip);
  });

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'chip-input';
  input.placeholder = atMax ? '' : 'Add character…';
  input.disabled = atMax;
  box.appendChild(input);
  container.appendChild(box);

  const suggestions = document.createElement('ul');
  suggestions.className = 'combobox-suggestions hidden';
  container.appendChild(suggestions);

  function commit(name) {
    if (!name || participant.characters.includes(name)) return;
    if (totalCharacters(i) >= charRange().max) return;
    participant.characters.push(name);
    renderParticipantChips(i, pIdx, container);
    container.querySelector('.chip-input')?.focus();
    refreshSiblingChips(i, pIdx);
  }

  const combobox = zhagoCombobox(input, suggestions, {
    getCandidates: (q) =>
      (gameData?.characters ?? [])
        .filter(
          (c) =>
            !participant.characters.includes(c.name) && (!q || c.name.toLowerCase().includes(q)),
        )
        .map((c) => ({ label: c.name, name: c.name })),
    onSelect: (c) => commit(c.name),
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value.trim();
      const exact = (gameData?.characters ?? []).find(
        (c) => c.name.toLowerCase() === q.toLowerCase(),
      );
      if (exact) commit(exact.name);
    } else if (e.key === 'Backspace' && !input.value && participant.characters.length) {
      participant.characters.pop();
      renderParticipantChips(i, pIdx, container);
      refreshSiblingChips(i, pIdx);
    } else if (e.key === 'Escape') {
      combobox.close();
    }
  });
}

function renderParticipants(i) {
  const container = participantContainers[i];
  container.innerHTML = '';

  participants[i].forEach((p, pIdx) => {
    const row = document.createElement('div');
    row.className = 'participant-row';

    const fields = document.createElement('div');
    fields.className = 'participant-fields';

    const teamInput = document.createElement('input');
    teamInput.className = 'participant-team form-control form-control-sm';
    teamInput.placeholder = 'Team (optional, e.g. FlyQuest)';
    teamInput.value = p.team;
    teamInput.addEventListener('input', () => {
      p.team = teamInput.value;
    });

    const playerInput = document.createElement('input');
    playerInput.className = 'form-control form-control-sm';
    playerInput.placeholder = 'Player tag';
    playerInput.value = p.player;
    playerInput.addEventListener('input', () => {
      p.player = playerInput.value;
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-outline-danger btn-sm';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      participants[i].splice(pIdx, 1);
      renderParticipants(i);
    });

    fields.append(teamInput, playerInput, remove);
    row.appendChild(fields);

    const chipField = document.createElement('div');
    chipField.className = 'chip-field';
    row.appendChild(chipField);
    renderParticipantChips(i, pIdx, chipField);

    container.appendChild(row);
  });

  addParticipantButtons[i].classList.toggle('hidden', participants[i].length >= playerRange().max);
}

function resetParticipants(i, values = []) {
  participants[i] = values.length
    ? values.map((p) => ({
        team: p.team ?? '',
        player: p.player ?? '',
        characters: p.characters ?? [],
      }))
    : [{ team: '', player: '', characters: [] }];
  renderParticipants(i);
}

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
for (const i of SIDES) {
  addParticipantButtons[i].addEventListener('click', () => {
    participants[i].push({ team: '', player: '', characters: [] });
    renderParticipants(i);
  });
}

// Static reference content — one snapshot is enough, so the stream closes
// itself after the first message instead of staying open for updates that
// will never come (see the 2xko/sf6/kofxv modules: get-current only, no
// `update`).
function loadGame(name, onReady) {
  if (!name) {
    gameData = null;
    onReady?.();
    return;
  }
  const es = new EventSource('/api/bus/' + name + '/stream');
  es.onmessage = (e) => {
    es.close();
    gameData = JSON.parse(e.data) || { characters: [] };
    onReady?.();
  };
}

function sideValues(i) {
  return {
    participants: participants[i]
      .filter((p) => p.player.trim())
      .map((p) => ({ team: p.team, player: p.player, characters: p.characters })),
  };
}

document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    game: gameSelect.value,
    round: roundInput.value,
    bestOf: Number(bestOfInput.value),
    sides: SIDES.map((i) => ({
      id: 'side-' + (i + 1),
      score: Number(scoreInputs[i].value),
      ...sideValues(i),
    })),
  };
  await fetch('/api/bus/match/set', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
});

source.onmessage = (e) => {
  const msg = JSON.parse(e.data);

  if (msg.ns === 'match-overlay') {
    if (skinSelect.value !== msg.data.skin) skinSelect.value = msg.data.skin;
    return;
  }

  const state = msg.data;
  roundInput.value = state.round ?? '';
  bestOfInput.value = state.bestOf ?? 0;
  SIDES.forEach((i) => {
    const side = state.sides?.[i];
    scoreInputs[i].value = side?.score ?? 0;
  });

  const targetGame = state.game || '';
  if (gameSelect.value !== targetGame) gameSelect.value = targetGame;
  loadGame(targetGame, () => {
    SIDES.forEach((i) => {
      const side = state.sides?.[i];
      resetParticipants(i, side?.participants || []);
    });
  });
};
