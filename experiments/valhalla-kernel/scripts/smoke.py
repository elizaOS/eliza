#!/usr/bin/env python3
"""Boot the actual ISO; fail on panic, hang, missing milestones, or bad exit."""
import argparse
from pathlib import Path
import subprocess
p=argparse.ArgumentParser()
p.add_argument('--qemu',default='qemu-system-x86_64')
p.add_argument('--memory',default='128M')
a=p.parse_args()
command=[a.qemu,'-accel','tcg','-m',a.memory,'-smp','1','-cdrom','build/valhalla.iso','-boot','d','-display','none','-serial','stdio','-monitor','none','-no-reboot','-device','isa-debug-exit,iobase=0xf4,iosize=0x04']
try:
    result=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30)
    output=result.stdout.decode('utf-8',errors='replace')
except subprocess.TimeoutExpired as e:
    output=(e.stdout or b'').decode('utf-8',errors='replace')
    Path('build/serial.log').write_text(output)
    raise SystemExit('QEMU timed out. See build/serial.log.')
Path('build/serial.log').write_text(output)
print(output,end='')
expected=['PASS physical memory and virtual mapping','PASS heap and daemon boundaries','PASS scheduler and daemon delivery','SELFTEST PASS']
if result.returncode!=1 or 'PANIC:' in output or any(x not in output for x in expected) or output.count('worker says hello')!=3:
    raise SystemExit(f'QEMU smoke check failed: emulator exit {result.returncode}')
print('QEMU smoke check passed (guest exit 0; isa-debug-exit host status 1).')
