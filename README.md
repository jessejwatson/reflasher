### What does reflasher do?

Reflasher has a server component and a client-side script component. Run up the server with the command below and then curl the client-side script from a Raspberry Pi ssh session as root. It will flash the SD card of the RPi with whatever image you have specified.

### Starting the server.

```bash
node serve-image.js rpi-image.img.xz
```

Default port is `8080`. Add `--port` followed by the port number to adjust (e.g. `--port 8081`).

### Running the script client side.

```bash
curl -fsSL http://SERVER_IP:PORT/reflash.sh | sudo bash
```

It is important that an IP Address is used, not a DNS name.
