// Country data + label/normalize helpers — shared by the country combobox
// (see participants.js) and anything else that wants to render a code as a
// readable name. `countries` is a live export: reassigning it here is
// visible to every importer without a setter, since ES module bindings are
// references, not snapshots taken at import time.
export let countries = [];

export function countryLabel(code) {
  const value = String(code || '').toLowerCase();
  const country = countries.find(
    (c) => c.code === value || c.id === value || c.iso?.toLowerCase() === value,
  );
  return country ? `${country.name} (${country.iso})` : code || '';
}

export function normalizeCountry(value) {
  const q = String(value || '')
    .trim()
    .toLowerCase();
  const country = countries.find(
    (c) => c.code === q || c.id === q || c.iso?.toLowerCase() === q || c.name.toLowerCase() === q,
  );
  return country?.code || q;
}

// Static reference content — one snapshot is enough, so the stream closes
// itself after the first message instead of staying open for updates that
// will never come (see the 2xko/sf6/kofxv modules: get-current only, no
// `update`).
export function loadCountries(onLoaded) {
  const es = new EventSource('/api/bus/countries/stream');
  es.onmessage = (e) => {
    es.close();
    countries = JSON.parse(e.data)?.countries || [];
    onLoaded?.();
  };
}
