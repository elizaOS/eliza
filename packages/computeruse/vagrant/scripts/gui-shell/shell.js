#!/usr/bin/env node

const net = require('net');
const { spawn } = require('child_process');
const path = require('path');

const PIPE_NAME = '\\\\.\\pipe\\my-pty-pipe';
const SERVER_PATH = path.join(__dirname, 'server.js');
const HELPER_PS1 = path.join(__dirname, 'helper.ps1');

function connect() {
    const socket = net.connect(PIPE_NAME);

    socket.on('error', () => {
        // Pipe doesn't exist — start server
        spawn('powershell.exe', [
            '-ExecutionPolicy', 'Bypass',
            '-File', HELPER_PS1,
            'node', SERVER_PATH
        ], {
            detached: true,
            stdio: 'ignore',
            shell: true,
            cwd: process.cwd(),
            env: process.env
        }).unref();

        // Retry after short delay
        setTimeout(connect, 2000);
    });

    socket.on('connect', () => {
        let ready = false;

        socket.on('data', data => {
            if (!ready) {
                const str = data.toString();
                if (str.includes('[READY]')) {
                    ready = true;

                    process.stdin.setRawMode(true);
                    process.stdin.resume();
                    process.stdin.pipe(socket);

                    const resizeMsg = Buffer.from([0xFF, ...Buffer.from(`${process.stdout.columns}:${process.stdout.rows}`)]);
                    socket.write(resizeMsg);


                    process.stdout.on('resize', () => {
                        const msg = Buffer.from([0xFF, ...Buffer.from(`${process.stdout.columns}:${process.stdout.rows}`)]);
                        socket.write(msg);
                    });


                    return;
                }
            }

            process.stdout.write(data);
        });
    });
}

connect(); 