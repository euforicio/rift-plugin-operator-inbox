# Operator Inbox

Operator Inbox is a standalone BB plugin that gives agents a durable,
project-scoped way to leave messages for a human operator. It adds a polished
Inbox panel, unread count, project and archive filters, sender-thread
navigation, mark-read/archive actions, and replies.

## Install

BB with SDK `0.4.35-inbox-parity.0` or a compatible newer SDK is required.
This candidate SDK is not published yet: clean registry installation and live
activation remain gated on its release and a matching BB host build.

```sh
git clone <repository-url>
cd bb-plugin-operator-inbox
npm ci
bb plugin install .
```

The plugin is enabled by default after installation. This repository does not
require or configure bb-collab.

## Use

Agents receive the native `send_operator_inbox_message` tool in new sessions.
The tool accepts `text` and one of three severities: `routine`, `urgent`, or
`needs-decision`. Project and sender-thread identity always come from BB's tool
context; the model cannot supply or override either value.

Open **Inbox** in BB's navigation to read messages. The panel can show one
project or all projects, include archived messages, open the sender thread,
mark a message read, archive it, or send one reply.

Replies go only through `bb.sdk.threads.send` to the sender thread recorded on
the message. The Inbox records BB's accepted result (`sent`, `queued`, or
`deferred`). Acceptance does not prove that a provider consumed the reply, and
the UI deliberately makes no such claim.

## Security

- BB plugins are full-trust server code; install only sources you trust.
- Messages and mutations are scoped by the project id captured by BB.
- Agent-authored Markdown is treated as untrusted. Raw HTML is escaped, unsafe
  URL schemes are rejected, and Markdown images render as alt text instead of
  loading remote image beacons.
- The plugin makes no third-party network requests and has no webhooks,
  background workers, schedules, watchers, or polling services.

## Data behavior

Messages live in the plugin-owned SQLite database at
`<bb-data-dir>/plugins/operator-inbox/data.db`. Read, archive, and accepted
reply state are durable across reloads and upgrades. Archiving retains a
message; the plugin has no automatic retention, export, or compatibility
migration from bb-collab state. Back up or remove `data.db` using the same data
handling policy as the rest of your BB installation.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm run verify` runs typecheck, tests, and `bb plugin build` together.

Message bodies and replies use BB's host-owned `Markdown`, with
`experimental_imagePolicy="alt-text"`. The plugin supplies only an explicit
file resolver: sender identity comes from the stored message and native
thread/environment/storage APIs, never from the current Inbox project or a
thread id embedded in a path. Missing or unsafe local targets stay inert.
Workspace and sender-storage paths use their native targets; other absolute
paths, including another thread's report, use the verified sender host.

Native `FileLink` currently gates browser hrefs, modified/auxiliary clicks,
and URL dragging. Use ordinary click/Enter or BB's native copy/open menu.
The plugin does not intercept DOM events or parse Markdown. The SDK test
Markdown is a text stub; real parser/media/navigation tests belong to the
matching host implementation and composed integration verification.

For this unpublished candidate, verification uses the reviewed SDK tarball from
BB-core commit `77549a615200698fc8c4d053c6eec320d9ef6562`, SHA256
`939e1dd06d965ed999bbf39965a524397f6c053c65e414161c66aee9625c3c80`.
The lockfile pins those bytes at the intended registry version; `npm ci` cannot
resolve it until publication. Do not substitute SDK 0.4.34 or reload this plugin
into that host: unsupported props would silently lose the safety policy.

## License

MIT
