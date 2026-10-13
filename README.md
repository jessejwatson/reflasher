### What does reflasher do?

Reflasher has a server component and a client-side script component. Run up the server, upload your images in the web UI, and assign each image to a named script (e.g. `pi4`, `pi3`). Then curl that script from a Raspberry Pi ssh session as root. It will flash the SD card of the RPi with the image assigned to that script.

### Starting the server.

Build the admin UI once (and again after changing anything in `ui/`):

```bash
cd ui && npm install && npm run build && cd ..
```

Then start the server in the directory that holds (or will hold) your images:

```bash
node serve-image.js
```

Default port is `8080`. Add `--port` followed by the port number to adjust (e.g. `--port 8081`). Use `--data DIR` to keep images somewhere other than the current directory.

Set `REFLASHER_PASSWORD` to require a password for the admin UI. The UI shows a login form; sessions last 7 days, and changing the password logs everyone out. Script and image downloads stay open so Pis can fetch them.

Or with Docker (images are stored in `./images`, override with `IMAGE_DIR`):

```bash
REFLASHER_PASSWORD=changeme docker compose up --build
```

### Behind a reverse proxy (e.g. Traefik).

The admin UI works under a path prefix (e.g. `/reflasher` with Traefik's `stripprefix`). Pis should still fetch scripts directly from `http://SERVER_IP:8080`, not through the proxy, so keep the port published. Set `REFLASHER_PUBLIC_URL=http://SERVER_IP:8080` so the UI shows Pis the right command.

Traefik v3 cuts off requests after 60s by default (`readTimeout`), which breaks large uploads. Either upload from `http://SERVER_IP:8080/` directly, or raise the timeout in Traefik's static config: `--entrypoints.web.transport.respondingTimeouts.readTimeout=0`.

### Managing images.

Open `http://SERVER_IP:PORT/` in a browser to:

- **Upload** `.img.xz` images.
- **Archive** images you want to keep but not serve, and **restore** them later.
- **Delete** images. An image assigned to a script must be unassigned before it can be archived or deleted.
- **Add scripts** and choose which image each one flashes. Changing a script's image takes effect for the next Pi that runs it.

On disk, active images sit in the data directory, archived ones in `archive/`, and the script assignments in `scripts.json`.

### Running the script client side.

```bash
curl -fsSL http://SERVER_IP:PORT/reflash/SCRIPT_NAME.sh | sudo bash
```

The admin UI shows a copyable command for each script. `/reflash.sh` is an alias for the script named `default`.

It is important that an IP Address is used, not a DNS name.

### Developing the UI.

Run `node serve-image.js` and, in `ui/`, `npm run dev`. Vite proxies `/api` to the server on port 8080.
