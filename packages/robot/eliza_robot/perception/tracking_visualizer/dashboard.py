"""Flask web dashboard for real-time tracking visualization.

Serves a browser-based dashboard with dual camera MJPEG streams
(robot IP camera + USB camera), detection overlays, a bird's-eye
scene view, and calibration / config controls.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from collections.abc import Generator
from contextlib import suppress
from pathlib import Path

import numpy as np

try:
    import cv2

    _HAS_CV2 = True
except ImportError:
    cv2 = None  # type: ignore[assignment]
    _HAS_CV2 = False

try:
    from flask import Flask, Response, jsonify, request, send_from_directory

    _HAS_FLASK = True
except ImportError:
    _HAS_FLASK = False

from eliza_robot.perception.calibration import CameraIntrinsics
from eliza_robot.perception.config import load_config
from eliza_robot.perception.detectors.aruco_detector import ArucoDetector
from eliza_robot.perception.frame_source import OpenCVSource
from eliza_robot.perception.tracking_visualizer.calibrator import RuntimeCalibrator
from eliza_robot.perception.tracking_visualizer.overlay import draw_all_overlays
from eliza_robot.perception.tracking_visualizer.scene_view import SceneRenderer
from eliza_robot.perception.tracking_visualizer.websocket_camera import IPCameraSource

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Embedded HTML dashboard
# ---------------------------------------------------------------------------

DASHBOARD_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Robot Tracking Visualizer</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f0f1a;color:#e0e0e0;font-family:'Segoe UI',system-ui,sans-serif}
.header{background:#161628;padding:10px 20px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #2a2a4a}
.header h1{font-size:16px;color:#7c8aff;font-weight:600}
.header .sb{font-size:12px;color:#888}
.grid{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:6px;padding:6px;height:calc(100vh - 44px)}
.panel{background:#161628;border-radius:6px;overflow:hidden;position:relative;display:flex;flex-direction:column}
.ph{padding:6px 12px;background:#1c1c36;font-size:12px;font-weight:600;color:#aaa;display:flex;justify-content:space-between}
.badge{padding:1px 8px;border-radius:10px;font-size:10px}
.badge.on{background:#2a4a2a;color:#4a4}.badge.off{background:#4a2a2a;color:#a44}
.panel img{flex:1;width:100%;object-fit:contain;background:#0a0a14;min-height:0}
.cp{overflow-y:auto;padding:12px}
h3{color:#7c8aff;font-size:13px;margin:14px 0 6px;padding-bottom:4px;border-bottom:1px solid #2a2a4a}
h3:first-child{margin-top:0}
.btn{background:#252548;border:1px solid #3a3a5a;color:#ccc;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px;margin:2px;transition:all .15s}
.btn:hover{background:#353568;border-color:#5a5a8a;color:#fff}
.btn.p{background:#2a3a7a;border-color:#4a5aaa}
.btn.p:hover{background:#3a4a9a}
label{display:flex;align-items:center;gap:6px;margin:4px 0;font-size:12px;cursor:pointer}
label input[type=checkbox]{accent-color:#7c8aff}
input[type=number]{background:#1a1a30;border:1px solid #3a3a5a;color:#ddd;padding:4px 6px;border-radius:3px;width:70px;font-size:12px}
.og{display:grid;grid-template-columns:auto 1fr auto;gap:4px 8px;align-items:center;font-size:12px}
.msg{padding:6px 10px;margin:6px 0;border-radius:4px;font-size:11px}
.msg.i{background:#1a2a4a;color:#8ac}.msg.ok{background:#1a3a2a;color:#8c8}.msg.er{background:#3a1a1a;color:#c88}
#sd{font-size:11px;color:#888;line-height:1.6}
</style>
</head>
<body>
<div class="header">
  <h1>Robot Tracking Visualizer</h1>
  <div class="sb" id="fp">--</div>
</div>
<div class="grid">
  <div class="panel">
    <div class="ph">Robot Camera (IP)<span class="badge off" id="br">--</span></div>
    <img src="/video/robot" alt="Robot Camera">
  </div>
  <div class="panel" id="usb-panel" style="position:relative">
    <div class="ph">USB Camera (External)
      <span>
        <label style="display:inline;font-size:10px;margin:0"><input type="checkbox" id="show-overlay" checked onchange="toggleOverlay()"> 2D</label>
        <label style="display:inline;font-size:10px;margin:0"><input type="checkbox" id="show-ar" checked onchange="if(window._arToggle)window._arToggle(this.checked)"> 3D</label>
        <span class="badge off" id="bu">--</span>
      </span>
    </div>
    <div style="flex:1;position:relative;min-height:0">
      <img src="/video/usb" alt="USB Camera" id="usb-img" style="width:100%;height:100%;object-fit:contain;position:absolute;top:0;left:0;z-index:0">
      <canvas id="ar-canvas" style="width:100%;height:100%;object-fit:contain;position:absolute;top:0;left:0;pointer-events:none;z-index:1"></canvas>
      <canvas id="overlay-canvas" style="width:100%;height:100%;object-fit:contain;position:absolute;top:0;left:0;pointer-events:none;z-index:2"></canvas>
    </div>
  </div>
  <div class="panel">
    <div class="ph">Scene View (Bird's Eye)<span class="badge on" id="bs">LIVE</span></div>
    <img src="/video/scene" alt="Scene View">
  </div>
  <div class="panel cp">
    <h3>System Status</h3>
    <div id="sd">Connecting...</div>

    <h3>USB Camera</h3>
    <div style="display:flex;align-items:center;gap:8px">
      <select id="usb-dev" style="background:#1a1a30;border:1px solid #3a3a5a;color:#ddd;padding:4px 8px;border-radius:3px;font-size:12px;flex:1"></select>
      <button class="btn p" onclick="switchCam()">Switch</button>
    </div>
    <div id="cam-msg"></div>

    <h3>Detection Overlays</h3>
    <label><input type="checkbox" id="show-aruco" checked onchange="tog(this)"> ArUco Markers</label>
    <label><input type="checkbox" id="show-faces" checked onchange="tog(this)"> Face Detection</label>
    <label><input type="checkbox" id="show-skeletons" checked onchange="tog(this)"> Skeleton Pose</label>
    <label><input type="checkbox" id="show-objects" checked onchange="tog(this)"> Object Detection</label>

    <h3>Robot Marker Offset</h3>
    <p style="font-size:11px;color:#888;margin-bottom:6px">
      Offset from body ArUco to robot center (metres).
      Marker is on back-right shoulder.
    </p>
    <div class="og">
      <span>X (fwd):</span><input type="number" id="ox" step="0.01" value="0.05"><span>m</span>
      <span>Y (left):</span><input type="number" id="oy" step="0.01" value="0.04"><span>m</span>
      <span>Z (up):</span><input type="number" id="oz" step="0.01" value="0.0"><span>m</span>
      <span>Heading:</span><input type="number" id="oh" step="5" value="0"><span>deg</span>
    </div>
    <button class="btn p" onclick="saveOff()" style="margin-top:6px">Apply Offset</button>
    <div id="om"></div>

    <h3>Floor Calibration</h3>
    <div>
      <button class="btn p" onclick="cal('start')">Start</button>
      <button class="btn" onclick="cal('capture')">Capture Frame</button>
      <button class="btn p" onclick="cal('finish')">Finish &amp; Save</button>
      <button class="btn" onclick="cal('auto')">Auto-Calibrate</button>
    </div>
    <div id="cm" class="msg i" style="display:none"></div>

    <h3>ArUco Navigation Demo</h3>
    <p style="font-size:11px;color:#888;margin-bottom:6px">
      Walk robot to each detected object marker using ground-plane geometry.
    </p>
    <div style="display:flex;gap:4px;flex-wrap:wrap">
      <button class="btn p" onclick="navStart('red_ball')">Go to Red Ball</button>
      <button class="btn p" onclick="navStart('blue_cube')">Go to Blue Cube</button>
      <button class="btn p" onclick="navStart()">All Objects</button>
      <button class="btn" onclick="navStop()" style="background:#5a2a2a;border-color:#8a3a3a">Stop</button>
    </div>
    <div style="margin-top:6px">
      <label>Robot IP: <input type="text" id="robot-ip" value="192.168.1.218" style="background:#1a1a30;border:1px solid #3a3a5a;color:#ddd;padding:4px 6px;border-radius:3px;width:120px;font-size:12px"></label>
      <label>Stride (m): <input type="number" id="nav-stride" value="0.015" step="0.001" style="width:60px"></label>
      <label>Turn step: <input type="number" id="nav-turn" value="8" step="1" style="width:50px"> deg</label>
      <label>Speed: <input type="number" id="nav-speed" value="2" step="1" min="1" max="4" style="width:40px"></label>
    </div>
    <div id="nav-log" style="font-size:10px;color:#8ac;max-height:120px;overflow-y:auto;margin-top:6px;font-family:monospace"></div>

    <h3>Floor Markers</h3>
    <div id="fm" style="font-size:11px;color:#999"></div>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/roslib@1/build/roslib.min.js"></script>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.164.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.164.1/examples/jsm/"}}</script>
<script type="module">
import {init as arInit, update as arUpdate, toggle as arToggle} from '/ar_overlay.js';
window._arUpdate = arUpdate;
window._arToggle = arToggle;
setTimeout(arInit, 800);
// Poll world state for AR overlay at ~5Hz
setInterval(async()=>{
  try{const r=await fetch('/api/world_state'); window._arUpdate(await r.json());}catch(e){}
}, 200);
</script>
<script>
// ---- AR Overlay: project world coords onto camera pixels via inverse homography ----
let _ovEnabled=true;
const _ovObjColors={6:'#ff4444',7:'#4488ff',8:'#44dd44'};

function toggleOverlay(){
  _ovEnabled=document.getElementById('show-overlay').checked;
  const c=document.getElementById('overlay-canvas');
  c.style.display=_ovEnabled?'block':'none';
}

// Project world XY → camera pixel using inverse homography
// Canvas is set to camera resolution and scaled via CSS object-fit:contain
// so we just return raw camera pixel coords
function world2px(H_inv, wx, wy){
  if(!H_inv) return null;
  const w=H_inv[0][0]*wx + H_inv[0][1]*wy + H_inv[0][2];
  const v=H_inv[1][0]*wx + H_inv[1][1]*wy + H_inv[1][2];
  const d=H_inv[2][0]*wx + H_inv[2][1]*wy + H_inv[2][2];
  if(Math.abs(d)<1e-9) return null;
  return [w/d, v/d];
}

function drawOverlay(ws){
  const c=document.getElementById('overlay-canvas');
  if(!c||!_ovEnabled) return;
  const Hi=ws.H_inv;
  if(!Hi) return;
  const cW=ws.cam_width||640, cH=ws.cam_height||480;
  // Set canvas internal resolution to match camera — CSS object-fit:contain
  // on the canvas will scale it identically to the <img> element
  if(c.width!==cW||c.height!==cH){c.width=cW;c.height=cH;}
  const ctx=c.getContext('2d');
  ctx.clearRect(0,0,cW,cH);

  function wp(wx,wy){ return world2px(Hi,wx,wy); }

  // Floor markers — green diamonds with labels
  const fm=ws.floor_markers||{};
  for(const [id,pos] of Object.entries(fm)){
    const p=wp(pos[0],pos[1]);
    if(!p) continue;
    ctx.save();
    ctx.translate(p[0],p[1]);
    ctx.rotate(Math.PI/4);
    ctx.strokeStyle='#00ff44'; ctx.lineWidth=2;
    ctx.strokeRect(-8,-8,16,16);
    ctx.restore();
    ctx.fillStyle='#00ff44'; ctx.font='bold 12px sans-serif';
    ctx.strokeStyle='#000'; ctx.lineWidth=3;
    ctx.strokeText('M'+id, p[0]+10, p[1]-4);
    ctx.fillText('M'+id, p[0]+10, p[1]-4);
  }

  // Floor polygon
  const fmKeys=Object.keys(fm).sort((a,b)=>parseInt(a)-parseInt(b));
  if(fmKeys.length>=3){
    ctx.strokeStyle='rgba(0,255,68,0.5)'; ctx.lineWidth=1.5;
    ctx.setLineDash([6,4]);
    ctx.beginPath();
    fmKeys.forEach((id,i)=>{
      const p=wp(fm[id][0],fm[id][1]);
      if(!p) return;
      i===0?ctx.moveTo(p[0],p[1]):ctx.lineTo(p[0],p[1]);
    });
    ctx.closePath(); ctx.stroke();
    ctx.setLineDash([]);
  }

  // Objects — colored circles with labels
  for(const obj of(ws.objects||[])){
    const p=wp(obj.position[0],obj.position[1]);
    if(!p) continue;
    const col=_ovObjColors[obj.marker_id]||'#ff00ff';
    // Glow
    ctx.beginPath(); ctx.arc(p[0],p[1],18,0,Math.PI*2);
    ctx.fillStyle=col+'33'; ctx.fill();
    // Solid circle
    ctx.beginPath(); ctx.arc(p[0],p[1],10,0,Math.PI*2);
    ctx.fillStyle=col; ctx.fill();
    ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.stroke();
    // Label
    ctx.fillStyle='#fff'; ctx.font='bold 13px sans-serif';
    ctx.strokeStyle='#000'; ctx.lineWidth=3;
    ctx.strokeText(obj.label, p[0]+14, p[1]+4);
    ctx.fillText(obj.label, p[0]+14, p[1]+4);
  }

  // Robot — triangle with heading arrow
  if(ws.robot_position){
    const rp=ws.robot_position, rh=ws.robot_heading||0;
    const p=wp(rp[0],rp[1]);
    if(p){
      // To get screen heading: project a point slightly ahead in world
      const aheadW=[rp[0]+0.15*Math.cos(rh), rp[1]+0.15*Math.sin(rh)];
      const pa=wp(aheadW[0],aheadW[1]);
      let screenAngle=0;
      if(pa) screenAngle=Math.atan2(pa[1]-p[1], pa[0]-p[0]);

      const sz=14;
      ctx.save();
      ctx.translate(p[0],p[1]);
      ctx.rotate(screenAngle);
      // Triangle
      ctx.fillStyle='rgba(0,140,255,0.85)';
      ctx.beginPath();
      ctx.moveTo(sz,0); ctx.lineTo(-sz*0.7,-sz*0.6); ctx.lineTo(-sz*0.7,sz*0.6);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle='#fff'; ctx.lineWidth=1.5; ctx.stroke();
      // Arrow
      ctx.strokeStyle='#ffff00'; ctx.lineWidth=2.5;
      ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(sz*2.2,0); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(sz*2.2,0); ctx.lineTo(sz*1.6,-4); ctx.lineTo(sz*1.6,4); ctx.closePath();
      ctx.fillStyle='#ffff00'; ctx.fill();
      ctx.restore();

      ctx.fillStyle='#88ccff'; ctx.font='bold 12px sans-serif';
      ctx.strokeStyle='#000'; ctx.lineWidth=3;
      ctx.strokeText('Robot', p[0]+16, p[1]-8);
      ctx.fillText('Robot', p[0]+16, p[1]-8);
    }
  }

  // Head
  const hm=(ws.all_markers||[]).find(m=>m.marker_id===1);
  if(hm){
    const p=wp(hm.position[0],hm.position[1]);
    if(p){
      ctx.beginPath(); ctx.arc(p[0],p[1],6,0,Math.PI*2);
      ctx.fillStyle='#00ddff'; ctx.fill();
      ctx.strokeStyle='#fff'; ctx.lineWidth=1; ctx.stroke();
    }
  }
}

setInterval(async()=>{
  if(!_ovEnabled) return;
  try{const r=await fetch('/api/world_state'); drawOverlay(await r.json());}catch(e){}
},200);
</script>
<script>
async function switchCam(){
  const dev=parseInt(document.getElementById('usb-dev').value);
  if(isNaN(dev))return;
  const r=await fetch('/api/usb_camera',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({device:dev})});
  const d=await r.json();const el=document.getElementById('cam-msg');
  el.className='msg '+(d.ok?'ok':'er');el.style.display='block';el.textContent=d.message;
  setTimeout(()=>el.style.display='none',3000);
}
let _camsLoaded=false;
async function loadCams(){
  if(_camsLoaded)return;
  try{
    const r=await fetch('/api/cameras');const d=await r.json();
    const sel=document.getElementById('usb-dev');
    sel.innerHTML='';
    d.cameras.forEach(c=>{
      const o=document.createElement('option');
      o.value=c.device;o.textContent='Device '+c.device+': '+c.resolution;
      if(c.active)o.selected=true;
      sel.appendChild(o);
    });
    _camsLoaded=true;
  }catch(e){}
}
loadCams();

// ---- ArUco Navigation Demo ----
let _navRunning=false, _ros=null, _walkPub=null, _walkSvc=null;
function navLog(msg){
  const el=document.getElementById('nav-log');
  el.innerHTML+=msg+'<br>';el.scrollTop=el.scrollHeight;
}
function rosConnect(){
  const ip=document.getElementById('robot-ip').value;
  if(_ros&&_ros.isConnected)return Promise.resolve();
  return new Promise((res,rej)=>{
    _ros=new ROSLIB.Ros({url:'ws://'+ip+':8888/ws_proxy'});
    _ros.on('connection',()=>{
      navLog('ROSBridge connected');
      _walkPub=new ROSLIB.Topic({ros:_ros,name:'/app/set_walking_param',messageType:'ainex_interfaces/AppWalkingParam'});
      _walkSvc=new ROSLIB.Service({ros:_ros,name:'/walking/command',serviceType:'ainex_interfaces/SetWalkingCommand'});
      res();
    });
    _ros.on('error',(e)=>{navLog('ROS error: '+e);rej(e);});
    setTimeout(()=>rej('timeout'),5000);
  });
}
function walkCmd(cmd){
  return new Promise((res,rej)=>{
    if(!_walkSvc){rej('no svc');return;}
    _walkSvc.callService(new ROSLIB.ServiceRequest({command:cmd}),(r)=>res(r),(e)=>rej(e));
  });
}
function publishWalk(x,y,angle){
  if(!_walkPub)return;
  const spd=parseInt(document.getElementById('nav-speed').value)||2;
  _walkPub.publish(new ROSLIB.Message({speed:spd,height:0.036,x:x,y:y,angle:angle}));
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function normalizeAngle(a){while(a>Math.PI)a-=2*Math.PI;while(a<-Math.PI)a+=2*Math.PI;return a;}

async function getWorldState(){
  const r=await fetch('/api/world_state');return r.json();
}

async function navStart(targetLabel){
  if(_navRunning){navLog('Already running');return;}
  _navRunning=true;
  document.getElementById('nav-log').innerHTML='';
  const stride=parseFloat(document.getElementById('nav-stride').value)||0.015;
  const turnStep=parseFloat(document.getElementById('nav-turn').value)||8;
  const arrivalDist=0.15; // meters
  const angleTol=0.25; // radians (~14 deg)

  try{
    await rosConnect();
    navLog('Fetching world state...');
    let ws=await getWorldState();
    if(!ws.robot_position){navLog('ERROR: Robot not visible! Need body marker (ID 0) in USB camera view.');_navRunning=false;return;}

    let targets=ws.objects||[];
    if(targetLabel) targets=targets.filter(o=>o.label===targetLabel);
    if(targets.length===0){navLog('ERROR: Target "'+targetLabel+'" not found. Visible: '+(ws.objects||[]).map(o=>o.label).join(', '));_navRunning=false;return;}

    navLog('Robot at ('+ws.robot_position[0].toFixed(2)+', '+ws.robot_position[1].toFixed(2)+')');
    navLog('Targets: '+targets.map(o=>o.label).join(', '));

    await walkCmd('start');
    navLog('Walking enabled');
    await sleep(500);

    // Heartbeat: continuously republish current walk command at 10Hz
    // The gait controller needs repeated messages to keep walking
    let curX=0, curY=0, curAngle=0;
    const hb=setInterval(()=>{
      if(_navRunning) publishWalk(curX, curY, curAngle);
    }, 100);

    for(const obj of targets){
      if(!_navRunning)break;
      navLog('--- Target: '+obj.label+' ---');

      for(let step=0;step<300&&_navRunning;step++){
        ws=await getWorldState();
        if(!ws.robot_position){
          navLog('Lost robot marker, holding...');
          curX=0; curY=0; curAngle=0;
          await sleep(500);
          continue;
        }

        const rx=ws.robot_position[0], ry=ws.robot_position[1];
        const rh=ws.robot_heading||0;

        const cur=(ws.objects||[]).find(o=>o.marker_id===obj.marker_id);
        const tx=cur?cur.position[0]:obj.position[0];
        const ty=cur?cur.position[1]:obj.position[1];

        const dx=tx-rx, dy=ty-ry;
        const dist=Math.sqrt(dx*dx+dy*dy);

        if(dist<arrivalDist){
          navLog('ARRIVED at '+obj.label+' ('+dist.toFixed(2)+'m)');
          curX=0; curY=0; curAngle=0;
          await sleep(1000);
          break;
        }

        const targetAngle=Math.atan2(dy, dx);
        const angleDiff=normalizeAngle(targetAngle - rh);

        // Always walk forward + steer proportionally
        // angle command is proportional to heading error, clamped to turnStep
        curAngle = Math.max(-turnStep, Math.min(turnStep, angleDiff * (turnStep / 0.5)));
        curX = stride;
        curY = 0;

        if(step%8===0) navLog(
          'pos=('+rx.toFixed(2)+','+ry.toFixed(2)+
          ') hdg='+(rh*180/Math.PI).toFixed(0)+
          ' err='+(angleDiff*180/Math.PI).toFixed(0)+
          'deg dist='+dist.toFixed(2)+'m'+
          ' [FWD x='+curX+' a='+curAngle.toFixed(1)+']'
        );

        await sleep(500);
      }
    }

    clearInterval(hb);
    navLog('=== Done ===');
    publishWalk(0,0,0);
    await sleep(300);
    await walkCmd('stop');
  }catch(e){
    navLog('ERROR: '+e);
  }
  _navRunning=false;
}

function navStop(){
  _navRunning=false;
  // Publish stop a few times to make sure it takes
  for(let i=0;i<5;i++) setTimeout(()=>{ if(_walkPub) publishWalk(0,0,0); }, i*100);
  if(_walkSvc)walkCmd('stop').catch(()=>{});
  navLog('STOPPED');
}

async function tog(el){
  const k=el.id.replace('show-','');
  await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({[k]:el.checked})});
}
async function saveOff(){
  const x=parseFloat(document.getElementById('ox').value)||0;
  const y=parseFloat(document.getElementById('oy').value)||0;
  const z=parseFloat(document.getElementById('oz').value)||0;
  const h=parseFloat(document.getElementById('oh').value)||0;
  const r=await fetch('/api/robot_offset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({x,y,z,heading_offset_deg:h})});
  const d=await r.json();const el=document.getElementById('om');
  el.className='msg ok';el.style.display='block';el.textContent=d.message||'Applied';
  setTimeout(()=>el.style.display='none',3000);
}
async function cal(a){
  const r=await fetch('/api/calibrate/'+a,{method:'POST'});
  const d=await r.json();const el=document.getElementById('cm');
  el.className='msg '+(d.ok?'ok':'i');el.style.display='block';el.textContent=d.message;
}
let _first=true;
setInterval(async()=>{
  try{
    const r=await fetch('/api/status');const d=await r.json();
    document.getElementById('fp').textContent=
      'FPS: '+d.fps.toFixed(1)+' | Entities: '+d.entity_count+' | Markers: '+d.marker_count;
    const rb=document.getElementById('br');
    rb.textContent=d.robot_camera?'LIVE':'OFF';rb.className='badge '+(d.robot_camera?'on':'off');
    const ub=document.getElementById('bu');
    ub.textContent=d.usb_camera?'LIVE':'OFF';ub.className='badge '+(d.usb_camera?'on':'off');
    let s='';
    if(d.robot_position)s+='Robot: ('+d.robot_position.map(v=>v.toFixed(2)).join(', ')+')<br>';
    s+='Detected: '+d.marker_count+' markers, '+d.entity_count+' entities<br>';
    if(d.calibration)s+='Calibration: '+d.calibration+'<br>';
    s+='Uptime: '+d.uptime+'s';
    document.getElementById('sd').innerHTML=s;
    if(d.robot_offset&&_first){
      document.getElementById('ox').value=d.robot_offset.x.toFixed(3);
      document.getElementById('oy').value=d.robot_offset.y.toFixed(3);
      document.getElementById('oz').value=d.robot_offset.z.toFixed(3);
      document.getElementById('oh').value=d.robot_offset.heading_offset_deg.toFixed(0);
      _first=false;
    }
    if(d.floor_markers){
      document.getElementById('fm').innerHTML=Object.entries(d.floor_markers)
        .map(([id,pos])=>'ID '+id+': ('+pos.map(v=>v.toFixed(2)).join(', ')+')')
        .join('<br>');
    }
  }catch(e){}
},1500);
</script>
</body>
</html>
"""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _no_signal_frame(w: int, h: int, text: str = "NO SIGNAL") -> np.ndarray:
    """Render a dark frame for a missing camera signal."""
    frame = np.zeros((h, w, 3), dtype=np.uint8)
    frame[::2, :] = 20
    if _HAS_CV2:
        (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.9, 2)
        x = (w - tw) // 2
        y = (h + th) // 2
        cv2.putText(frame, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (60, 60, 80), 2)
    return frame


# ---------------------------------------------------------------------------
# Per-camera processor
# ---------------------------------------------------------------------------

class CameraProcessor:
    """Reads frames, runs detectors, draws overlays."""

    def __init__(
        self,
        name: str,
        intrinsics: CameraIntrinsics,
        marker_size_m: float = 0.0508,
    ) -> None:
        self.name = name
        self.intrinsics = intrinsics
        self._aruco = ArucoDetector(
            intrinsics=intrinsics, marker_size_m=marker_size_m,
        )
        self._face_det = None
        self._skel_est = None
        self._obj_det = None
        self._loaded = False

        # Latest results (guarded by lock)
        self.latest_frame: np.ndarray | None = None
        self.latest_annotated: np.ndarray | None = None
        self.latest_aruco: list = []
        self.latest_faces: list = []
        self.latest_skeletons: list = []
        self.latest_objects: list = []
        # Persistent ArUco: never remove, only update when re-detected
        self._persistent_aruco: dict = {}  # marker_id -> ArucoDetection
        self.lock = threading.Lock()
        self.fps = 0.0
        self._fps_t0 = time.monotonic()
        self._fps_n = 0

    def load_detectors(self) -> None:
        """Load heavy ML models (call from background thread)."""
        if self._loaded:
            return
        self._loaded = True

        try:
            from eliza_robot.perception.detectors.face_detector import FaceDetector
            fd = FaceDetector(confidence_threshold=0.5)
            if fd.is_available:
                self._face_det = fd
                logger.info("[%s] Face detector ready", self.name)
        except Exception as e:
            logger.info("[%s] Face detector unavailable: %s", self.name, e)

        try:
            from eliza_robot.perception.detectors.skeleton_estimator import SkeletonEstimator
            se = SkeletonEstimator(confidence_threshold=0.3)
            if se.is_available:
                self._skel_est = se
                logger.info("[%s] Skeleton estimator ready", self.name)
        except Exception as e:
            logger.info("[%s] Skeleton estimator unavailable: %s", self.name, e)

        try:
            from eliza_robot.perception.detectors.object_detector import ObjectDetector
            od = ObjectDetector(confidence_threshold=0.5)
            if od.is_available:
                self._obj_det = od
                logger.info("[%s] Object detector ready", self.name)
        except Exception as e:
            logger.info("[%s] Object detector unavailable: %s", self.name, e)

    def process(self, frame: np.ndarray, show: dict) -> np.ndarray:
        """Run detectors + overlay.  Returns annotated frame."""
        # FPS bookkeeping
        self._fps_n += 1
        now = time.monotonic()
        if now - self._fps_t0 >= 1.0:
            self.fps = self._fps_n / (now - self._fps_t0)
            self._fps_n = 0
            self._fps_t0 = now

        with self.lock:
            self.latest_frame = frame.copy()

        aruco_fresh = self._aruco.detect(frame)
        faces = self._face_det.detect(frame) if self._face_det else []
        skeletons = self._skel_est.estimate(frame) if self._skel_est else []
        objects = self._obj_det.detect(frame) if self._obj_det else []

        # Merge into persistent ArUco — update seen markers, keep unseen ones
        for det in aruco_fresh:
            self._persistent_aruco[det.marker_id] = det
        persistent_list = list(self._persistent_aruco.values())

        with self.lock:
            self.latest_aruco = persistent_list  # persistent for world state
            self.latest_faces = faces
            self.latest_skeletons = skeletons
            self.latest_objects = objects

        # Draw overlay using FRESH detections only (valid pixel coords)
        annotated = draw_all_overlays(
            frame,
            aruco=aruco_fresh,
            faces=faces,
            skeletons=skeletons,
            objects=objects,
            intrinsics=self.intrinsics,
            show_aruco=show.get("aruco", True),
            show_faces=show.get("faces", True),
            show_skeletons=show.get("skeletons", True),
            show_objects=show.get("objects", True),
        )

        if _HAS_CV2:
            cv2.putText(
                annotated, f"{self.fps:.1f} FPS", (10, 25),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 1, cv2.LINE_AA,
            )

        with self.lock:
            self.latest_annotated = annotated

        return annotated


# ---------------------------------------------------------------------------
# Main dashboard
# ---------------------------------------------------------------------------

class TrackingDashboard:
    """Ties cameras, detectors, scene view, calibration into a web UI."""

    def __init__(
        self,
        robot_camera_url: str = "",
        usb_camera_device: int = 0,
        config_path: str | None = None,
        host: str = "0.0.0.0",
        port: int = 5555,
    ) -> None:
        cfg_path = Path(config_path) if config_path else None
        self._cfg = load_config(cfg_path)

        self._host = host
        self._port = port
        self._t0 = time.monotonic()

        # Intrinsics
        self._usb_intr = CameraIntrinsics(
            fx=self._cfg.external_camera.fx,
            fy=self._cfg.external_camera.fy,
            cx=self._cfg.external_camera.cx,
            cy=self._cfg.external_camera.cy,
            dist_coeffs=self._cfg.external_camera.dist_coeffs,
            width=self._cfg.external_camera.width,
            height=self._cfg.external_camera.height,
        )
        self._robot_intr = CameraIntrinsics(
            fx=self._cfg.camera.fx,
            fy=self._cfg.camera.fy,
            cx=self._cfg.camera.cx,
            cy=self._cfg.camera.cy,
            dist_coeffs=self._cfg.camera.dist_coeffs,
            width=self._cfg.camera.width,
            height=self._cfg.camera.height,
        )

        # Sources
        self._robot_url = robot_camera_url
        self._usb_dev = usb_camera_device
        self._robot_src: IPCameraSource | None = None
        self._usb_src: OpenCVSource | None = None

        # Processors
        self._robot_proc = CameraProcessor(
            "robot", self._robot_intr, self._cfg.markers.marker_size_m,
        )
        self._usb_proc = CameraProcessor(
            "usb", self._usb_intr, self._cfg.markers.marker_size_m,
        )

        # Scene
        self._scene = SceneRenderer(canvas_size=800, world_range=3.0)
        self._scene.update_floor_markers(self._cfg.markers.world_markers)

        # Calibrator
        self._cal = RuntimeCalibrator(
            world_markers=self._cfg.markers.world_markers,
            marker_size_m=self._cfg.markers.marker_size_m,
        )

        # UI toggles
        self._show: dict[str, bool] = {
            "aruco": True,
            "faces": True,
            "skeletons": True,
            "objects": True,
        }

        # Pre-rendered no-signal frames
        self._ns_robot = _no_signal_frame(
            self._cfg.camera.width, self._cfg.camera.height,
            "ROBOT CAMERA - NO SIGNAL",
        )
        self._ns_usb = _no_signal_frame(
            self._cfg.external_camera.width,
            self._cfg.external_camera.height,
            "USB CAMERA - NO SIGNAL",
        )

        self._scene_frame: np.ndarray = self._scene.render()
        self._scene_lock = threading.Lock()
        self._running = False

    # -- lifecycle --

    def start(self) -> None:
        self._running = True

        # Robot camera
        if self._robot_url:
            logger.info("Opening robot camera: %s", self._robot_url)
            self._robot_src = IPCameraSource(self._robot_url)

        # USB camera
        try:
            logger.info("Opening USB camera: device %d", self._usb_dev)
            self._usb_src = OpenCVSource(
                device=self._usb_dev,
                width=self._cfg.external_camera.width,
                height=self._cfg.external_camera.height,
            )
            if not self._usb_src.is_open:
                logger.warning("USB camera not available")
                self._usb_src = None
        except Exception as e:
            logger.warning("USB camera open failed: %s", e)
            self._usb_src = None

        # Background threads
        threading.Thread(target=self._load_detectors, daemon=True).start()
        threading.Thread(target=self._robot_loop, daemon=True).start()
        threading.Thread(target=self._usb_loop, daemon=True).start()
        threading.Thread(target=self._scene_loop, daemon=True).start()

        self._run_flask()

    def switch_usb_camera(self, device: int) -> str:
        """Switch to a different USB camera device at runtime."""
        logger.info("Switching USB camera to device %d", device)
        # Release old
        if self._usb_src is not None:
            self._usb_src.release()
            self._usb_src = None
        # Clear processor state
        with self._usb_proc.lock:
            self._usb_proc.latest_frame = None
            self._usb_proc.latest_annotated = None
            self._usb_proc.latest_aruco = []
        # Open new
        try:
            self._usb_src = OpenCVSource(
                device=device,
                width=self._cfg.external_camera.width,
                height=self._cfg.external_camera.height,
            )
            if not self._usb_src.is_open:
                self._usb_src = None
                return f"Device {device} could not be opened"
            self._usb_dev = device
            return f"Switched to device {device}"
        except Exception as e:
            self._usb_src = None
            return f"Error opening device {device}: {e}"

    @staticmethod
    def enumerate_cameras(max_dev: int = 10) -> list[dict]:
        """Probe /dev/video* and return usable devices."""
        results = []
        for i in range(max_dev):
            try:
                cap = cv2.VideoCapture(i)
                if cap.isOpened():
                    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
                    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
                    fps = cap.get(cv2.CAP_PROP_FPS)
                    cap.release()
                    results.append({
                        "device": i,
                        "resolution": f"{w}x{h} @ {fps:.0f}fps",
                    })
                else:
                    cap.release()
            except Exception:
                pass
        return results

    def stop(self) -> None:
        self._running = False
        if self._robot_src:
            self._robot_src.release()
        if self._usb_src:
            self._usb_src.release()

    # -- background threads --

    def _load_detectors(self) -> None:
        logger.info("Loading ML detectors (may take a moment)...")
        self._robot_proc.load_detectors()
        self._usb_proc.load_detectors()
        logger.info("Detectors ready")

    def _robot_loop(self) -> None:
        while self._running:
            if self._robot_src is not None:
                ok, frame = self._robot_src.read()
                if ok:
                    self._robot_proc.process(frame, self._show)
                    continue
            time.sleep(0.05)

    def _usb_loop(self) -> None:
        while self._running:
            if self._usb_src is not None and self._usb_src.is_open:
                ok, frame = self._usb_src.read()
                if ok:
                    self._usb_proc.process(frame, self._show)
                    self._update_scene_from_usb()
                    continue
            time.sleep(0.05)

    def _scene_loop(self) -> None:
        while self._running:
            rendered = self._scene.render()
            with self._scene_lock:
                self._scene_frame = rendered
            time.sleep(0.05)

    # -- scene update from USB camera ArUco --

    # Persistent homography (pixel center → world XY)
    _homography: np.ndarray | None = None
    # Camera pose from solvePnP (for 3D AR overlay)
    _camera_pose: dict | None = None

    def _compute_homography(self, aruco: list) -> np.ndarray | None:
        """Compute pixel→world homography from visible floor markers.

        Uses marker center pixels and their known world XY positions.
        Needs >= 4 floor markers for a good result (exact for 4 coplanar).
        """
        world_cfg = self._cfg.markers.world_markers
        src_pts = []  # pixel centers
        dst_pts = []  # world XY
        for det in aruco:
            if det.marker_id in world_cfg:
                wpos = world_cfg[det.marker_id]
                src_pts.append(det.center_pixel.tolist())
                dst_pts.append([wpos[0], wpos[1]])
        if len(src_pts) < 4:
            return None
        H, mask = cv2.findHomography(
            np.array(src_pts, dtype=np.float64),
            np.array(dst_pts, dtype=np.float64),
        )
        return H

    def _compute_camera_pose(self, aruco: list) -> dict | None:
        """Compute camera pose via solvePnP for the 3D AR overlay."""
        world_cfg = self._cfg.markers.world_markers
        obj_pts = []
        img_pts = []
        for det in aruco:
            if det.marker_id in world_cfg:
                wpos = world_cfg[det.marker_id]
                obj_pts.append([wpos[0], wpos[1], 0.0])
                img_pts.append(det.center_pixel.tolist())
        if len(obj_pts) < 4:
            return None
        # Use actual frame dimensions for intrinsics
        act_w, act_h = 640, 480
        with self._usb_proc.lock:
            if self._usb_proc.latest_frame is not None:
                act_h, act_w = self._usb_proc.latest_frame.shape[:2]
        fx = fy = act_w * 0.78  # rough approximation
        cx, cy = act_w / 2, act_h / 2
        K = np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], dtype=np.float64)
        ok, rvec, tvec = cv2.solvePnP(
            np.array(obj_pts, dtype=np.float64),
            np.array(img_pts, dtype=np.float64),
            K, np.zeros(5), flags=cv2.SOLVEPNP_ITERATIVE,
        )
        if not ok:
            return None
        return {
            "rvec": rvec.ravel().tolist(),
            "tvec": tvec.ravel().tolist(),
            "fx": float(fx), "fy": float(fy),
            "cx": float(cx), "cy": float(cy),
        }

    def _pixel_to_world(self, pixel: np.ndarray) -> np.ndarray | None:
        """Map a pixel coordinate to world XY using the homography."""
        if self._homography is None:
            return None
        p = np.array([pixel[0], pixel[1], 1.0], dtype=np.float64)
        w = self._homography @ p
        if abs(w[2]) < 1e-9:
            return None
        return np.array([w[0] / w[2], w[1] / w[2], 0.0])

    def _marker_heading_from_corners(self, det) -> float:
        """Compute marker heading from its corner pixels via homography.

        Maps two corners to world coords and uses the vector between
        them to determine orientation.  ArUco corner order is
        TL, TR, BR, BL — the top edge (TL→TR) is the marker's local
        +X direction.
        """
        if self._homography is None:
            return 0.0
        # Map corner 0 (TL) and corner 1 (TR) to world — that's marker +X
        c0 = self._pixel_to_world(det.corners[0])
        c1 = self._pixel_to_world(det.corners[1])
        if c0 is None or c1 is None:
            return 0.0
        dx = c1[0] - c0[0]
        dy = c1[1] - c0[1]
        marker_x_heading = math.atan2(dy, dx)
        # Marker +Y is 90° CCW from +X
        marker_y_heading = marker_x_heading + math.pi / 2
        return marker_y_heading

    def _update_scene_from_usb(self) -> None:
        with self._usb_proc.lock:
            aruco = list(self._usb_proc.latest_aruco)
        if not aruco:
            return

        # Compute homography + camera pose once, then persist
        # Only recompute if we don't have one yet, or if we see all 4 floor markers
        # (opportunistic refinement). Never clear existing values.
        if self._homography is None:
            H = self._compute_homography(aruco)
            if H is not None:
                self._homography = H
                logger.info("Homography computed from floor markers")
        if self._camera_pose is None:
            pose = self._compute_camera_pose(aruco)
            if pose is not None:
                self._camera_pose = pose
                logger.info("Camera pose computed via solvePnP")
        if self._homography is None:
            return

        robot_ids = set(self._cfg.markers.robot_marker_ids)
        head_id = self._cfg.markers.robot_head_marker_id
        robot_pos = None
        robot_heading = 0.0
        head_pos = None

        offset_rad = math.radians(self._cal.robot_offset.heading_offset_deg)

        for det in aruco:
            if det.marker_id in robot_ids:
                wpos = self._pixel_to_world(det.center_pixel)
                if wpos is not None:
                    robot_pos = wpos
                    raw_heading = self._marker_heading_from_corners(det)
                    robot_heading = raw_heading + offset_rad
            elif det.marker_id == head_id:
                head_pos = self._pixel_to_world(det.center_pixel)

        self._scene.update_robot_pose(robot_pos, robot_heading, head_pos)

        # Map all non-floor, non-robot markers to world as entities for scene view
        world_ids = set(self._cfg.markers.world_markers.keys())
        obj_markers = self._cfg.markers.object_markers
        entities: list[dict] = []
        for det in aruco:
            mid = det.marker_id
            if mid in robot_ids or mid == head_id or mid in world_ids:
                continue
            wpos = self._pixel_to_world(det.center_pixel)
            if wpos is None:
                continue
            label = obj_markers.get(mid, f"marker_{mid}")
            entities.append({
                "label": label,
                "position": wpos.tolist(),
                "type": "object",
                "confidence": det.confidence,
                "velocity": [0, 0, 0],
            })
        self._scene.update_entities(entities)

    # -- MJPEG generator --

    def _mjpeg_stream(
        self,
        get_frame,
        fallback: np.ndarray,
    ) -> Generator[bytes, None, None]:
        while self._running:
            frame = get_frame()
            if frame is None:
                frame = fallback
            _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n" + buf.tobytes() + b"\r\n"
            )
            time.sleep(0.033)

    # -- Flask app --

    def _run_flask(self) -> None:
        if not _HAS_FLASK:
            logger.error("Flask not installed.  pip install flask")
            return

        app = Flask(__name__)
        app.logger.setLevel(logging.WARNING)
        dashboard = self  # closure reference

        # Serve hyperscape assets (GLB models, emotes)
        _hyperscape_assets = Path(__file__).resolve().parents[3] / "hyperscape" / "assets"
        # Serve ar_overlay.js
        _viz_dir = Path(__file__).resolve().parent

        @app.route("/assets/<path:subpath>")
        def serve_asset(subpath: str):
            full = _hyperscape_assets / subpath
            if full.exists() and full.is_file():
                return send_from_directory(str(full.parent), full.name)
            return "Not found", 404

        @app.route("/ar_overlay.js")
        def serve_ar_js():
            return send_from_directory(str(_viz_dir), "ar_overlay.js",
                                       mimetype="application/javascript")

        @app.route("/")
        def index():
            return DASHBOARD_HTML

        @app.route("/video/robot")
        def video_robot():
            def _get():
                with dashboard._robot_proc.lock:
                    return dashboard._robot_proc.latest_annotated
            return Response(
                dashboard._mjpeg_stream(_get, dashboard._ns_robot),
                mimetype="multipart/x-mixed-replace; boundary=frame",
            )

        @app.route("/video/usb")
        def video_usb():
            def _get():
                with dashboard._usb_proc.lock:
                    return dashboard._usb_proc.latest_annotated
            return Response(
                dashboard._mjpeg_stream(_get, dashboard._ns_usb),
                mimetype="multipart/x-mixed-replace; boundary=frame",
            )

        @app.route("/video/scene")
        def video_scene():
            def _get():
                with dashboard._scene_lock:
                    return dashboard._scene_frame
            return Response(
                dashboard._mjpeg_stream(_get, dashboard._scene.render()),
                mimetype="multipart/x-mixed-replace; boundary=frame",
            )

        @app.route("/api/status")
        def api_status():
            rp = None
            if dashboard._scene._robot_position is not None:
                rp = dashboard._scene._robot_position.tolist()
            return jsonify({
                "fps": max(dashboard._robot_proc.fps, dashboard._usb_proc.fps),
                "robot_camera": (
                    dashboard._robot_src is not None
                    and dashboard._robot_src.is_connected
                ),
                "usb_camera": (
                    dashboard._usb_src is not None
                    and dashboard._usb_src.is_open
                ),
                "entity_count": len(dashboard._scene._entities),
                "marker_count": (
                    len(dashboard._usb_proc.latest_aruco)
                    + len(dashboard._robot_proc.latest_aruco)
                ),
                "robot_position": rp,
                "calibration": dashboard._cal.state.message,
                "uptime": int(time.monotonic() - dashboard._t0),
                "robot_offset": {
                    "x": dashboard._cal.robot_offset.x,
                    "y": dashboard._cal.robot_offset.y,
                    "z": dashboard._cal.robot_offset.z,
                    "heading_offset_deg": dashboard._cal.robot_offset.heading_offset_deg,
                },
                "floor_markers": {
                    str(k): v
                    for k, v in dashboard._cfg.markers.world_markers.items()
                },
                "show": dashboard._show,
                "usb_device": dashboard._usb_dev,
            })

        @app.route("/api/config", methods=["POST"])
        def api_config():
            data = request.get_json() or {}
            for k in ("aruco", "faces", "skeletons", "objects"):
                if k in data:
                    dashboard._show[k] = bool(data[k])
            return jsonify({"ok": True, "show": dashboard._show})

        @app.route("/api/robot_offset", methods=["POST"])
        def api_robot_offset():
            data = request.get_json() or {}
            dashboard._cal.set_robot_offset(
                x=float(data.get("x", 0)),
                y=float(data.get("y", 0)),
                z=float(data.get("z", 0)),
                heading_offset_deg=float(data.get("heading_offset_deg", 0)),
            )
            o = dashboard._cal.robot_offset
            return jsonify({
                "ok": True,
                "message": f"Offset: pos=({o.x:.3f}, {o.y:.3f}, {o.z:.3f}) heading={o.heading_offset_deg:.0f}deg",
            })

        @app.route("/api/world_state")
        def api_world_state():
            """Return all tracked positions in world frame for navigation."""
            rp = None
            rh = 0.0
            if dashboard._scene._robot_position is not None:
                rp = dashboard._scene._robot_position.tolist()
                rh = dashboard._scene._robot_heading

            with dashboard._usb_proc.lock:
                aruco = list(dashboard._usb_proc.latest_aruco)

            obj_markers = dashboard._cfg.markers.object_markers
            robot_ids = set(dashboard._cfg.markers.robot_marker_ids)
            head_id = dashboard._cfg.markers.robot_head_marker_id
            world_ids = set(dashboard._cfg.markers.world_markers.keys())
            has_H = dashboard._homography is not None

            # Map all markers to world XY via homography
            objects = []
            all_markers = []
            for det in aruco:
                mid = det.marker_id
                wpos = dashboard._pixel_to_world(det.center_pixel)
                wpos_list = wpos.tolist() if wpos is not None else [0, 0, 0]

                all_markers.append({
                    "marker_id": mid,
                    "position": wpos_list,
                    "distance": det.distance,
                    "pixel": det.center_pixel.tolist(),
                })

                if mid not in robot_ids and mid != head_id and mid not in world_ids:
                    label = obj_markers.get(mid, f"marker_{mid}")
                    objects.append({
                        "marker_id": mid,
                        "label": label,
                        "position": wpos_list,
                        "distance_from_camera": det.distance,
                    })

            # Inverse homography: world XY → pixel coords for AR overlay
            H_inv = None
            if dashboard._homography is not None:
                with suppress(np.linalg.LinAlgError):
                    H_inv = np.linalg.inv(dashboard._homography).tolist()

            # Get actual frame size from latest frame (not config)
            act_w = dashboard._cfg.external_camera.width
            act_h = dashboard._cfg.external_camera.height
            with dashboard._usb_proc.lock:
                if dashboard._usb_proc.latest_frame is not None:
                    act_h, act_w = dashboard._usb_proc.latest_frame.shape[:2]

            return jsonify({
                "robot_position": rp,
                "robot_heading": rh,
                "objects": objects,
                "all_markers": all_markers,
                "floor_markers": {
                    str(k): v
                    for k, v in dashboard._cfg.markers.world_markers.items()
                },
                "has_homography": has_H,
                "H_inv": H_inv,
                "cam_width": act_w,
                "cam_height": act_h,
                "camera_pose": dashboard._camera_pose,
            })

        @app.route("/api/cameras")
        def api_cameras():
            cams = dashboard.enumerate_cameras()
            for c in cams:
                c["active"] = c["device"] == dashboard._usb_dev
            return jsonify({"cameras": cams})

        @app.route("/api/usb_camera", methods=["POST"])
        def api_usb_camera():
            data = request.get_json() or {}
            dev = int(data.get("device", 0))
            msg = dashboard.switch_usb_camera(dev)
            ok = dashboard._usb_src is not None and dashboard._usb_src.is_open
            return jsonify({"ok": ok, "message": msg, "device": dev})

        @app.route("/api/calibrate/<action>", methods=["POST"])
        def api_calibrate(action: str):
            if action == "start":
                msg = dashboard._cal.start_floor_calibration()
                return jsonify({"ok": True, "message": msg})
            if action == "capture":
                with dashboard._usb_proc.lock:
                    f = dashboard._usb_proc.latest_frame
                if f is None:
                    return jsonify({"ok": False, "message": "No frame available"})
                msg = dashboard._cal.capture_frame(f)
                return jsonify({"ok": True, "message": msg})
            if action == "finish":
                ad = ArucoDetector(
                    intrinsics=dashboard._usb_intr,
                    marker_size_m=dashboard._cfg.markers.marker_size_m,
                )
                ext, msg = dashboard._cal.finish_floor_calibration(
                    dashboard._usb_intr, ad, "external",
                )
                return jsonify({"ok": ext is not None, "message": msg})
            if action == "auto":
                with dashboard._usb_proc.lock:
                    a = list(dashboard._usb_proc.latest_aruco)
                if not a:
                    return jsonify({"ok": False, "message": "No markers visible"})
                ext = dashboard._cal.quick_calibrate(
                    a, dashboard._usb_intr, "external",
                )
                if ext is None:
                    return jsonify({
                        "ok": False,
                        "message": "Need floor markers visible",
                    })
                return jsonify({
                    "ok": True,
                    "message": f"Auto-calibrated! Error: {ext.reprojection_error:.3f}px",
                })
            return jsonify({"ok": False, "message": f"Unknown: {action}"})

        # Silence werkzeug per-request logs
        logging.getLogger("werkzeug").setLevel(logging.WARNING)

        print(f"\n  Tracking Visualizer Dashboard: http://localhost:{self._port}\n")
        app.run(
            host=self._host,
            port=self._port,
            threaded=True,
            use_reloader=False,
        )
