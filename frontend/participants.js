// Everything about editing a side's participant list — rendering, the
// player/team/country/character comboboxes, and the game-declared ranges
// that bound how many participants/characters a side can have. Split out of
// index.js once that file got large; index.js still owns the score/winner/
// swap/publish flow and just calls into here for anything participant-shaped.
import { countries, countryLabel, normalizeCountry } from './countries.js';

const SIDES = [0, 1];

// One participant = one team + one player + their character(s). A side is
// participants[], not flat players[]/characters[] arrays, because a flat
// pairing can't express a cross-org duo (2XKO: FLY's SonicFox on Senna +
// SHR's INZEM on Teemo, one side, two different teams). `charactersPerSide`
// bounds the SIDE's total across every participant, not each participant
// individually — no game-specific split rule (e.g. "2XKO duo splits 1 each")
// is enforced here; the TO assigns characters to whichever participant
// actually plays them.
export const participants = SIDES.map(() => []);

let gameData = null; // { characters, charactersPerSide, playersPerSide, ... } from the selected game module
export let playersRoster = [];

export function setPlayersRoster(list) {
  playersRoster = list;
  SIDES.forEach((i) => renderParticipants(i));
}

export function findPlayerByName(name) {
  return playersRoster.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
}

const participantContainers = SIDES.map((i) => document.getElementById('side-' + i + '-participants'));
const addParticipantButtons = SIDES.map((i) => document.getElementById('side-' + i + '-add-participant'));

for (const i of SIDES) {
  addParticipantButtons[i].addEventListener('click', () => {
    participants[i].push({ team: '', player: '', country: '', characters: [] });
    renderParticipants(i);
  });
}

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

function totalCharacters(i) {
  return participants[i].reduce((sum, p) => sum + p.characters.length, 0);
}

// charactersPerSide bounds the whole side, not each participant — after any
// add/remove, every *other* participant's chip box on this side needs to
// re-check its own atMax too, or a sibling's box goes stale (still shows
// "Add character…" and accepts typing even though the side is already full).
function refreshSiblingChips(i, skipPIdx) {
  participantContainers[i].querySelectorAll('.chip-field').forEach((chipField, pIdx) => {
    if (pIdx !== skipPIdx) renderParticipantChips(i, pIdx, chipField);
  });
}

// Called after a game switch, before re-rendering — a duo's 2 participants
// (or a side's characters) can be over the *new* game's limits if the
// previous game allowed more.
export function clampToRanges(i) {
  const pMax = playerRange().max;
  if (participants[i].length > pMax) participants[i] = participants[i].slice(0, pMax);

  let remaining = charRange().max;
  for (const p of participants[i]) {
    if (p.characters.length > remaining) p.characters = p.characters.slice(0, Math.max(remaining, 0));
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
        .filter((c) => !participant.characters.includes(c.name) && (!q || c.name.toLowerCase().includes(q)))
        .map((c) => ({ label: c.name, name: c.name })),
    onSelect: (c) => commit(c.name),
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value.trim();
      const exact = (gameData?.characters ?? []).find((c) => c.name.toLowerCase() === q.toLowerCase());
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

export function renderParticipants(i) {
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

    const countryField = document.createElement('div');
    countryField.className = 'country-field combobox';

    const countryInput = document.createElement('input');
    countryInput.className = 'form-control form-control-sm';
    countryInput.placeholder = 'Country';
    countryInput.value = countryLabel(p.country);
    countryInput.addEventListener('input', () => {
      p.country = normalizeCountry(countryInput.value);
    });

    const countrySuggestions = document.createElement('ul');
    countrySuggestions.className = 'combobox-suggestions hidden';
    countryField.append(countryInput, countrySuggestions);

    zhagoCombobox(countryInput, countrySuggestions, {
      getCandidates: (q) =>
        countries
          .filter(
            (c) => !q || c.name.toLowerCase().includes(q) || c.code.includes(q) || c.iso.toLowerCase().includes(q),
          )
          .map((c) => ({ label: c.name, meta: c.iso, code: c.code })),
      onSelect: (c) => {
        p.country = c.code;
        countryInput.value = countryLabel(c.code);
      },
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-outline-danger btn-sm';
    remove.textContent = '×';
    const canRemove = participants[i].length > playerRange().min;
    remove.disabled = !canRemove;
    remove.classList.toggle('hidden', !canRemove);
    remove.addEventListener('click', () => {
      if (participants[i].length <= playerRange().min) return;
      participants[i].splice(pIdx, 1);
      renderParticipants(i);
    });

    fields.append(teamInput, countryField, remove);

    // Player tag renders above team/country — a TO filling this out types
    // who's playing first, team/country are secondary details.
    const secondaryFields = document.createElement('div');
    secondaryFields.className = 'participant-fields';

    const playerField = document.createElement('div');
    playerField.className = 'player-field combobox';

    const playerInput = document.createElement('input');
    playerInput.className = 'participant-player form-control form-control-sm';
    playerInput.placeholder = 'Player tag';
    playerInput.autocomplete = 'off';
    playerInput.value = p.player;
    playerInput.addEventListener('input', () => {
      p.player = playerInput.value;
    });

    const playerSuggestions = document.createElement('ul');
    playerSuggestions.className = 'combobox-suggestions hidden';
    playerField.append(playerInput, playerSuggestions);

    // players is suggestions, not a hard constraint — same shape as
    // casters' commentator picker. Picking one also fills team/country from
    // the roster, so a returning player doesn't need those retyped by hand.
    zhagoCombobox(playerInput, playerSuggestions, {
      getCandidates: (q) =>
        playersRoster
          .filter((pl) => !q || pl.name.toLowerCase().includes(q))
          .map((pl) => ({
            label: pl.name,
            meta: [pl.team, countryLabel(pl.country)].filter(Boolean).join(' · '),
            player: pl,
          })),
      onSelect: (item) => {
        p.player = item.player.name;
        playerInput.value = item.player.name;
        p.team = item.player.team || '';
        teamInput.value = p.team;
        p.country = item.player.country || '';
        countryInput.value = countryLabel(p.country);
      },
    });

    secondaryFields.append(playerField);
    row.appendChild(secondaryFields);
    row.appendChild(fields);

    const chipField = document.createElement('div');
    chipField.className = 'chip-field combobox';
    row.appendChild(chipField);
    renderParticipantChips(i, pIdx, chipField);

    container.appendChild(row);
  });

  addParticipantButtons[i].classList.toggle('hidden', participants[i].length >= playerRange().max);
}

export function resetParticipants(i, values = []) {
  participants[i] = values.length
    ? values.map((p) => ({
        team: p.team ?? '',
        player: p.player ?? '',
        country: p.country ?? '',
        characters: p.characters ?? [],
      }))
    : [{ team: '', player: '', country: '', characters: [] }];
  renderParticipants(i);
}

export function swapParticipants() {
  [participants[0], participants[1]] = [participants[1], participants[0]];
  SIDES.forEach((i) => renderParticipants(i));
}

export function loadGame(name, onReady) {
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
