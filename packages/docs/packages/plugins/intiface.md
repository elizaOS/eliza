# @elizaos/plugin-intiface

Intiface/Buttplug.io integration plugin for Eliza OS that enables control of intimate hardware devices.

## Features

- Support for multiple intimate hardware devices through Buttplug.io protocol
- Automatic device discovery and connection management
- Battery level monitoring for supported devices
- Vibration and rotation control (device-dependent)
- Graceful connection handling and cleanup
- Built-in device simulation for testing
- Support for customizable vibration patterns
- Automatic Intiface Engine management

## Installation

```bash
pnpm install @elizaos/plugin-intiface
```

## Configuration

The plugin can be configured through environment variables or runtime settings:

```env
INTIFACE_URL=ws://localhost:12345
INTIFACE_NAME=Eliza Intiface Client
DEVICE_NAME=Lovense Nora
```

## Usage

### Basic Device Control

```typescript
import { intifacePlugin } from "@elizaos/plugin-intiface";

// Vibrate device
const result = await eliza.execute({
    action: "VIBRATE",
    content: {
        strength: 0.5, // 0.0 to 1.0
        duration: 1000, // milliseconds
    },
});

// Check battery level
const battery = await eliza.execute({
    action: "BATTERY",
    content: {},
});
```

### Advanced Features

```typescript
// Rotation control (for supported devices)
const result = await eliza.execute({
    action: "ROTATE",
    content: {
        strength: 0.7,
        duration: 2000,
    },
});
```

## Device Support

The plugin supports various devices through the Buttplug protocol, including but not limited to:

- Lovense devices (Nora, Max, etc.)
- WeVibe products
- Kiiroo devices
- Magic Motion products
- And many others supported by Buttplug.io

## Testing

The plugin includes a simulation mode for testing without physical hardware:

```bash
pnpm test-via-bun
```

## Dependencies

- Buttplug.io (v3.2.2)
- Intiface Engine
- WebSocket support

## Troubleshooting

### Common Issues

1. **Connection Problems**

    - Verify Intiface Engine is running (`ws://localhost:12345` by default)
    - Check device Bluetooth is enabled and in pairing mode
    - Ensure device is charged and within range
    - Try restarting both device and Intiface Engine

2. **Device Not Found**

    - Confirm device is supported by Buttplug.io
    - Try manual device pairing through Intiface Central first
    - Check if device requires specific firmware version
    - Verify device is not connected to another application

3. **Command Failures**

    - Check battery level is sufficient
    - Ensure device is within supported range for command values
    - Verify device supports the specific command (vibrate/rotate)
    - Monitor Intiface Engine logs for detailed error messages

4. **Performance Issues**
    - Reduce command frequency if experiencing lag
    - Check for Bluetooth interference
    - Monitor system resources for potential bottlenecks
    - Consider using wired connection if available

## Security Best Practices

1. **Device Privacy**

    - Use secure WebSocket connections (wss://) when possible
    - Don't expose Intiface Engine to public networks
    - Regularly check for and apply firmware updates
    - Monitor device connection status

2. **Data Protection**

    - Clear device pairing history when needed
    - Don't store sensitive device information
    - Use unique device names for identification
    - Implement timeouts for idle connections

3. **Access Control**

    - Limit device control to authenticated users
    - Implement command rate limiting
    - Use device-specific permissions where applicable
    - Monitor and log unusual command patterns

4. **Network Security**
    - Keep Intiface Engine behind firewall
    - Use local connections when possible
    - Implement connection timeouts
    - Regular security audits of configurations

## Contributing

Contributions are welcome! Please see the CONTRIBUTING.md file for more information.

## Credits

This plugin integrates with [Buttplug.io](https://buttplug.io) and [Intiface Engine](https://github.com/intiface/intiface-engine), developed by Nonpolynomial Labs, LLC.

Special thanks to:

- The Buttplug.io team for developing the Buttplug.io protocol
- The Intiface Engine team for developing the Intiface Engine
- The Eliza community for their contributions and feedback.

For more information about Buttplug.io and Intiface Engine:

- [Buttplug.io](https://buttplug.io)
- [Intiface Engine](https://github.com/intiface/intiface-engine)

## License

This plugin is part of the Eliza project. See the main project repository for license information.

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
