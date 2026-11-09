# Setlists

Imports [setlist.fm](https://www.setlist.fm) links into Aurral as playlists.

- **An artist's setlists page**, like `setlist.fm/setlists/radiohead-bd6bd12.html`, gives you their current tour: the latest show in order, then every other song they've played on the tour, most played first. Keep it synced and it picks up tour debuts and surprise songs after each show. When setlist.fm has no tour name for an artist, it uses their recent shows instead.
- **One setlist**, like `setlist.fm/setlist/radiohead/2025/royal-arena-copenhagen-denmark-34cc517.html`, gives you that show in order.

Covers are listed under the original artist, so Aurral can find a recording. Intro tapes are left out.

## Setup

1. Sign in to setlist.fm and apply for an API key at [setlist.fm/settings/api](https://www.setlist.fm/settings/api). Keys are free for non-commercial use.
2. Install the plugin from `https://github.com/lklynet/aurral-plugins`.
3. Open **Setlists**, paste the key, select **Test**, and turn it on.

## Use

Open **Import playlist**, pick **setlist.fm**, and paste a link.

Tour pages on setlist.fm can't be imported, because the setlist.fm API can't look them up. Paste the artist's setlists page instead.

## Privacy

Setlists sends setlist.fm the artist and setlist from the link you paste, along with your API key. It sends nothing from your Library.

## License

MIT
