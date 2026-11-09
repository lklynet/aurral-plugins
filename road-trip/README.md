# Road Trip

An [Aurral](https://github.com/lklynet/aurral) plugin that turns Google Maps directions into a playlist as long as the drive.

Songs play near the places they belong to. Pass La Grande and you hear Laura Gibson's "La Grande". Roll into Boise and it's Built to Spill. Each stretch of road gets songs named after the towns along it and music by artists born or formed there. 

## Install

Needs an Aurral with plugins, currently nightly.

1. In **Settings > Plugins**, paste `https://github.com/lklynet/aurral-plugins` under **Install from a link**, select **Check**, and choose **Road Trip**.
2. Open **Road Trip** and turn it on.

## Use

1. Get driving directions in Google Maps and share the link. Short `maps.app.goo.gl` links work, and so do routes with stops.
2. In Aurral, open **Import playlist**, pick **Road Trip**, and paste the link.
3. Wait. Building a playlist takes about a minute, longer for very long drives.

The playlist is named like "Portland to Boise · 6h 49m" and ends within a minute or two of the drive time. Aurral downloads the tracks you don't have through your usual sources. Importing the same link again returns the same playlist.

Directions must start from a named place. "Your location" isn't in the link, so Road Trip can't route from it.

## How it picks songs

- Valhalla, a free routing service on OpenStreetMap data, plans the route and drive time. It stops at 1,500 km, so Road Trip traces longer legs with OSRM and times them in pieces.
- Wikidata lists towns of at least 1,000 people near the route, and musicians born or formed in them.
- MusicBrainz finds songs named after those towns. ListenBrainz listen counts drop the ones nobody plays.
- Deezer gives each local artist's top tracks.
- A scheduler fills the drive so each song plays near the town it came from.

All of these are free and need no account or key. Road Trip sends them place names, coordinates, and artist names. It sends nothing from your Library.

These are shared community services with rate limits, so a busy moment can make an import slow or thin. If a playlist comes out short, import the link again. Road Trip only keeps playlists that fill at least 90% of the drive.

## License

MIT
