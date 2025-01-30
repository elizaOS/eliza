# Intiface Engine

[![Patreon donate button](https://img.shields.io/badge/patreon-donate-yellow.svg)](https://www.patreon.com/qdot)
[![Github donate button](https://img.shields.io/badge/github-donate-ff69b4.svg)](https://www.github.com/sponsors/qdot)
[![Discourse Forums](https://img.shields.io/discourse/status?label=buttplug.io%20forums&server=https%3A%2F%2Fdiscuss.buttplug.io)](https://discuss.buttplug.io)
[![Discord](https://img.shields.io/discord/353303527587708932.svg?logo=discord)](https://discord.buttplug.io)
[![Twitter](https://img.shields.io/twitter/follow/buttplugio.svg?style=social&logo=twitter)](https://twitter.com/buttplugio)

![Intiface Engine Build](https://github.com/intiface/intiface-engine/workflows/Intiface%20Engine%20Build/badge.svg) ![crates.io](https://img.shields.io/crates/v/intiface-engine.svg)

<p align="center">
  <img src="https://raw.githubusercontent.com/buttplugio/buttplug-rs/dev/buttplug/docs/buttplug_rust_docs.png">
</p>

CLI and Library frontend for Buttplug

Intiface Engine is just a front-end for [Buttplug](https://github.com/buttplugio/buttplug),
but since we're trying to not make people install a program named "Buttplug", here we are.

While this program can be used standalone, it will mostly be featured as a backend/engine for
Intiface Central.

## Running

Command line options are as follows:

| Option                           | Description                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `version`                        | Print version and exit                                                                       |
| `server-version`                 | Print version and exit (kept for legacy reasons)                                             |
| `crash-reporting`                | Turn on sentry crash reporting                                                               |
| `websocket-use-all-interfaces`   | Websocket servers will listen on all interfaces (versus only on localhost, which is default) |
| `websocket-port [port]`          | Network port for connecting via non-ssl (ws://) protocols                                    |
| `frontend-websocket-port`        | IPC JSON port for Intiface Central                                                           |
| `server-name`                    | Identifying name server should emit when asked for info                                      |
| `device-config-file [file]`      | Device configuration file to load (if omitted, uses internal)                                |
| `user-device-config-file [file]` | User device configuration file to load (if omitted, none used)                               |
| `max-ping-time [number]`         | Milliseconds for ping time limit of server (if omitted, set to 0)                            |
| `log`                            | Level of logs to output by default (if omitted, set to None)                                 |
| `allow-raw`                      | Allow clients to communicate using raw messages (DANGEROUS, CAN BRICK SOME DEVICES)          |
| `use_bluetooth-le`               | Use the Bluetooth LE Buttplug Device Communication Manager                                   |
| `use-serial`                     | Use the Serial Port Buttplug Device Communication Manager                                    |
| `use-hid`                        | Use the HID Buttplug Device Communication Manager                                            |
| `use-lovense-dongle`             | Use the HID Lovense Dongle Buttplug Device Communication Manager                             |
| `use-xinput`                     | Use the XInput Buttplug Device Communication Manager                                         |
| `use-lovense-connect`            | Use the Lovense Connect Buttplug Device Communication Manager                                |
| `use-device-websocket-server`    | Use the Device Websocket Server Buttplug Device Communication Manager                        |
| `device-websocket-server-port`   | Port for the device websocket server                                                         |

For example, to run the server on websockets at port 12345 with bluetooth device support:

`intiface-engine --weboscket-port 12345 --use-bluetooth-le`

## Compiling

Linux will have extra compilation dependency requirements via
[buttplug-rs](https://github.com/buttplugio/buttplug-rs). For packages required,
please check there.

## Contributing

Right now, we mostly need code/API style reviews and feedback. We don't really have any good
bite-sized chunks to mentor the implementation yet, but one we do, those will be marked "Help
Wanted" in our [github issues](https://github.com/buttplugio/buttplug-rs/issues).

As we need money to keep up with supporting the latest and greatest hardware, we also have multiple
ways to donate!

- [Patreon](https://patreon.com/qdot)
- [Github Sponsors](https://github.com/sponsors/qdot)
- [Ko-Fi](https://ko-fi.com/qdot76367)

## License and Trademarks

Intiface is a Registered Trademark of Nonpolynomial Labs, LLC

Buttplug and Intiface are BSD licensed.

    Copyright (c) 2016-2022, Nonpolynomial Labs, LLC
    All rights reserved.

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice, this
      list of conditions and the following disclaimer.

    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.

    * Neither the name of buttplug nor the names of its
      contributors may be used to endorse or promote products derived from
      this software without specific prior written permission.

    THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
    AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
    IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
    DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
    FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
    DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
    SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
    CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
    OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
    OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
