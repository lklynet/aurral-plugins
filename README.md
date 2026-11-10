# Aurral plugins

Official plugins for [Aurral](https://github.com/lklynet/aurral).

| Plugin | What it does |
| --- | --- |
| [Lidarr](lidarr) | Downloads albums through Lidarr and plays them from Lidarr's folders. |
| [Road Trip](road-trip) | Turns Google Maps directions into a playlist as long as the drive. |
| [Setlists](setlists) | Imports setlist.fm links as playlists: one show, or an artist's current tour. |

## Install

Needs an Aurral with plugins, currently nightly.

1. In **Settings > Plugins**, paste `https://github.com/lklynet/aurral-plugins` under **Install from a link** and select **Check**.
2. Choose the plugins you want and install them.
3. Open each one, fill in its settings, and turn it on.

Aurral checks this repo for new versions once a day and shows **Update** on each plugin that changed.

## Contributing

Each plugin is a folder with a `manifest.json`, an `index.js`, and a `README.md`. The [plugin API](https://docs.aurral.org/api/plugins/) covers the rest. A release publishes every plugin in the repo, so bump the `version` of each plugin you changed.

## License

MIT
