# files.md

Vault is a private Markdown vault. Every note is a plain `.md` file in `~/Vault` on the Mac Studio. You can edit the files in the app or in any editor, and the search index keeps up with both. The app runs on the web, macOS and iOS, built with [Exact](https://github.com/expo/exact).

## How it fits together

`vault/server.ts` is the vault. It runs on the Mac under launchd and listens only on `127.0.0.1:4778`. `tailscale serve` publishes it at `https://mac-studio.brown-ling.ts.net:4777`, and only devices on the tailnet can reach that address. The server also checks each request's `Host` and `Origin` against that hostname and loopback, so a page on another site can't read or write your notes.

The server keeps a SQLite FTS5 index (`~/Vault/.index.sqlite`) of every note's title, path and text. At startup it reconciles the index with the folder, then follows changes through a recursive file watcher. Search matches word prefixes, ranks title hits above body hits, and returns a snippet of each match.

When you delete a note, it moves to `~/Vault/.trash/`. A save sends the version you started editing, and the server refuses the save if the file changed on disk since then.

The app has three files. `vault/app.contract` is the view. `vault/app.ts` talks to the server. `vault/app.test.contract` holds the tests that run on every host.

## Running

```sh
cd vault
bun exact.mjs test web          # also: test macos, test ios
VAULT_URL=https://mac-studio.brown-ling.ts.net:4777 bun exact.mjs mac --run
VAULT_URL=https://mac-studio.brown-ling.ts.net:4777 bun exact.mjs ios --run
VAULT_URL=https://mac-studio.brown-ling.ts.net:4777 bun run build   # web app into dist/, served by the vault at /
```

Without `VAULT_URL`, a build talks to `http://127.0.0.1:4777`, which is the server that `test` starts on an empty scratch vault. Don't put `VAULT_URL` in `.env.local`, because the tests read that file too.

The launchd agent is `~/Library/LaunchAgents/com.henrypl.vault.plist`, and its log is `~/Library/Logs/Vault/server.log`. To restart the server after you change it:

```sh
launchctl kickstart -k gui/$(id -u)/com.henrypl.vault
```

To stop publishing the vault on the tailnet, run `tailscale serve --https=4777 off`.
