// Train wraps: community art, sponsored ads and specials painted on the side of train cars.
// A script (not JSON) so the station still works when opened straight from disk.
//
// How to add one:
//   1. Put the image in this folder. One panel = one car side, 104 x 60 px PNG (pixel art reads best).
//      A design can span the whole train: list 2-6 panels and they're used car by car, repeating.
//   2. Add an entry below. Every wrap is reviewed by hand before it goes live.
//
// Fields:
//   id      unique name
//   type    'art' (community graffiti) | 'ad' (always labelled "Sponsored") | 'special' (milestone blocks only)
//   panels  image files in this folder
//   credit  name shown when someone clicks the train
//   link    optional, https:// only, opened from the train card (never from the image itself)
//   weight  how often it's picked relative to the others
//   active  { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' | null } so ads expire on their own
globalThis.WRAPS = [
  {
    id: 'run-buy-it',
    type: 'art',
    panels: ['run-buy-it.png'],
    credit: 'a community supporter',
    link: null,
    weight: 1,
    active: { from: '2026-10-07', to: null },
  },
];
