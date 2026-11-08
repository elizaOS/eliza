#!/usr/bin/env python3
"""Boot the actual ISO and require serial evidence plus QEMU's debug-exit status."""
import argparse
from pathlib import Path
import subprocess
import sys
p=argparse.ArgumentParser()
p.add_argument('--qemu',default='qemu-system-x86_64')
p.add_argument('--memory',default='128M')
a=p.parse_args()
command=[a.qemu,'-accel','tcg','-m',a.memory,'-smp','1','-cdrom','build/valhalla-v38.iso','-boot','d','-display','none','-serial','stdio','-monitor','none','-no-reboot','-device','isa-debug-exit,iobase=0xf4,iosize=0x04']
try:
    r=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30)
    output=r.stdout
    status=r.returncode
except subprocess.TimeoutExpired as e:
    output=e.stdout or b''
    status=-1
Path('build').mkdir(exist_ok=True)
Path('build/qemu-serial.log').write_bytes(output)
text=output.decode('utf-8','replace')
sys.stdout.write(text)
expected=['PASS physical allocator, virtual alias, unmap, heap','PASS daemon ABI, FIFO, queue saturation, wraparound','PASS cooperative context switch and thread exit','V38_SMOKE_PASS']
if status!=33 or any(marker not in text for marker in expected) or text.count('worker says hello')!=3 or 'PANIC:' in text:
    sys.exit(f'Smoke test failed: emulator exit={status}; see build/qemu-serial.log')
print(f'QEMU smoke passed ({a.memory}, exit=33).')
