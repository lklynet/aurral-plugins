# Lidarr

An [Aurral](https://github.com/lklynet/aurral) plugin that downloads albums through [Lidarr](https://lidarr.audio).

When Aurral wants an album, the plugin asks Lidarr for it. Lidarr grabs it with its own indexers and download clients and files it in its own folder. Aurral then plays the album from that folder and never moves, renames, or deletes it.

## Install

Needs Aurral 3.0, currently nightly.

1. In **Settings > Library**, add each of Lidarr's root folders as a read-only folder.
2. In **Settings > Plugins**, paste `https://github.com/lklynet/aurral-plugins` under **Install from a link**, select **Check**, and choose **Lidarr**.
3. Open **Lidarr** and enter Lidarr's URL and API key. The key is in Lidarr under **Settings > General**.
4. Select **Test**, then turn the plugin on.

If Lidarr and Aurral see the music at different paths, as they often do in Docker, fill in both path settings. With Lidarr's root folder at `/music` and the same folder mounted in Aurral at `/mnt/media/music`, enter those two.

## Use

Lidarr joins your other download sources, and its priority decides when Aurral tries it. Request an album as usual. A single track comes from its album.

- If the artist isn't in Lidarr, the plugin adds it to Lidarr's first root folder, or the one you name in the settings, with that folder's default profiles and the tag `aurral-plugin`. It monitors only the album you asked for.
- If the artist is already in Lidarr, the plugin monitors the album and starts a search.
- When Lidarr finds nothing, or its download fails or needs a manual import, Aurral moves on to your next source. The album stays monitored in Lidarr, so Lidarr may still get it later.

The plugin only adds to Lidarr. It never unmonitors, removes, or deletes anything there, and cancelling a download in Aurral leaves Lidarr's download running.

Quality profiles, metadata profiles, and upgrades stay in Lidarr. Aurral doesn't upgrade or retag files in Lidarr's folders.

## Privacy

The plugin talks only to your Lidarr server. It sends the IDs of the albums you request.

## License

MIT
