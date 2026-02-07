const net = require('net');
const os = require('os');
const pty = require('@lydell/node-pty');

const PIPE_NAME = '\\\\.\\pipe\\my-pty-pipe';

const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

const server = net.createServer(socket => {
    // Create a new ptyProcess for each client
    const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: process.stdout.columns,
        rows: process.stdout.rows,
        cwd: process.cwd(),
        env: process.env,
    });

    socket.write('[READY]\n'); // handshake

    ptyProcess.onData(data => socket.write(data));

    // Close socket when shell exits
    ptyProcess.onExit(() => {
        socket.end();
    });

    socket.on('data', data => {
        // resize if client sends: <0xFF><cols>:<rows>\n
        if (data[0] === 0xFF) {
            const [cols, rows] = data.slice(1).toString().split(':').map(Number);
            ptyProcess.resize(cols, rows);
        } else {
            ptyProcess.write(data);
        }
    });

    socket.on('close', () => {
        ptyProcess.kill();
    });
});

server.listen(PIPE_NAME, () => {
    console.log(`Server listening on ${PIPE_NAME}`);
});