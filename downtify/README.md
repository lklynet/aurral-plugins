# Downtify

An [Aurral](https://github.com/lklynet/aurral) plugin that downloads songs and albums through [Downtify](https://github.com/henriquesebastiao/downtify).

When Aurral wants a song or an album, the plugin asks Downtify for it. Downtify fetches it the way it fetches its own downloads: from YouTube Music, slskd, SoundCloud, or Deezer through Deemix, whichever you turned on there, with covers, lyrics, and tags. Aurral then copies the finished files into its own staging folder, checks them like any download, and files them in your Library.

## Install

Needs Aurral 3.0, currently nightly, and a Downtify with Aurral support (Settings > Apps > Aurral).

1. In Downtify, open **Settings > Apps > Aurral**, turn on **Let Aurral download through Downtify**, and save.
2. Select **Make a key** and copy it. Downtify shows it once.
3. In Aurral's **Settings > Plugins**, select **use the official plugins** under **Install from a link**, and choose **Downtify**.
4. Open **Downtify** and enter Downtify's URL and the key.
5. Select **Test**, then turn the plugin on.

## Use

Downtify joins your other download sources, and its priority decides when Aurral tries it. Request songs and albums as usual.

- **Search.** The plugin sends the artist and title, or the album, and Downtify answers with what YouTube Music has, with lengths. When Downtify only uses YouTube sources, it also says the format and bitrate it converts to.
- **Download.** Aurral picks a result and Downtify downloads it. The plugin checks every 15 seconds and copies the finished files over the network when they are ready, so the two apps don't need to share a folder.
- **Already in Downtify.** A song Downtify already has is handed over from its library as it is, without downloading it again.
- **Failures.** When Downtify finds nothing, or its download fails, Aurral moves on to your next source. An album keeps the tracks Downtify got, and Aurral matches them to the release.

Downtify keeps these downloads out of its own library: they go to a folder of their own and are deleted once Aurral has them, when Aurral cancels, or after a day. Cancelling a download in Aurral cancels it in Downtify.

Downtify's audio sources, formats, and parallel download limit stay in Downtify. Aurral downloads share that limit with Downtify's own queue.

## Privacy

The plugin talks only to your Downtify server. It sends the artist, title, and album of what you request. Downtify then searches its own sources for it.

## License

MIT
