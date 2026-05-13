#!/usr/bin/env bash
#
# 快速验证 sandbox HTTP 服务 + Docker 容器化流程
#
# 使用方式:
#   bash scripts/test_sandbox.sh
#
# 前置条件:
#   Docker daemon 正在运行 (docker ps 能用) — Phase 2/3 需要，Phase 1 不需要
#
set -euo pipefail
cd "$(dirname "$0")/.."

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }

# ====================================================================
# Phase 0: 安装依赖
# ====================================================================
info "Phase 0: 安装依赖"
pip install -r requirements-sandbox-server.txt -q 2>&1 | tail -1
pip install -r requirements.txt -q 2>&1 | tail -1
pip install -e . -q 2>&1 | tail -1
pass "依赖安装完成"

echo ""
# ====================================================================
# Phase 1: 本地直接启动 sandbox server（不需要 Docker）
# ====================================================================
info "Phase 1: 本地启动 sandbox server 冒烟测试"

# 启动 sandbox server 在后台
python src/claw_eval/sandbox/server.py --port 18080 &
SERVER_PID=$!
sleep 2

# 确认进程存活
if ! kill -0 $SERVER_PID 2>/dev/null; then
    fail "Sandbox server 启动失败"
fi

# 1.1 health check
HEALTH=$(curl -s http://localhost:18080/health)
echo "$HEALTH" | python -c "import sys,json; d=json.load(sys.stdin); assert d['status']=='ok'" \
    && pass "/health 返回 ok" \
    || fail "/health 异常: $HEALTH"

# 1.2 exec
EXEC_RESULT=$(curl -s -X POST http://localhost:18080/exec \
    -H 'Content-Type: application/json' \
    -d '{"command":"echo hello-sandbox"}')
echo "$EXEC_RESULT" | python -c "
import sys, json
d = json.load(sys.stdin)
assert d['exit_code'] == 0
assert 'hello-sandbox' in d['stdout']
" && pass "/exec echo hello-sandbox" \
  || fail "/exec 异常: $EXEC_RESULT"

# 1.3 write + read
curl -s -X POST http://localhost:18080/write \
    -H 'Content-Type: application/json' \
    -d '{"path":"/tmp/sandbox_test.txt","content":"test-content-12345"}' > /dev/null

READ_RESULT=$(curl -s -X POST http://localhost:18080/read \
    -H 'Content-Type: application/json' \
    -d '{"path":"/tmp/sandbox_test.txt"}')
echo "$READ_RESULT" | python -c "
import sys, json
d = json.load(sys.stdin)
assert d['content'] == 'test-content-12345'
" && pass "/write + /read 文件读写" \
  || fail "/read 异常: $READ_RESULT"

# 1.4 glob
GLOB_RESULT=$(curl -s -X POST http://localhost:18080/glob \
    -H 'Content-Type: application/json' \
    -d '{"pattern":"/tmp/sandbox_test*"}')
echo "$GLOB_RESULT" | python -c "
import sys, json
d = json.load(sys.stdin)
assert len(d['files']) >= 1
" && pass "/glob 文件匹配" \
  || fail "/glob 异常: $GLOB_RESULT"

# 1.5 exec timeout
TIMEOUT_RESULT=$(curl -s -X POST http://localhost:18080/exec \
    -H 'Content-Type: application/json' \
    -d '{"command":"sleep 10","timeout_seconds":1}')
echo "$TIMEOUT_RESULT" | python -c "
import sys, json
d = json.load(sys.stdin)
assert d['exit_code'] == -1
assert 'Timed out' in d['stderr']
" && pass "/exec 超时处理" \
  || fail "/exec 超时异常: $TIMEOUT_RESULT"

# 1.6 read 不存在的文件
READ_404=$(curl -s -X POST http://localhost:18080/read \
    -H 'Content-Type: application/json' \
    -d '{"path":"/tmp/nonexistent_file_xyz.txt"}')
echo "$READ_404" | python -c "
import sys, json
d = json.load(sys.stdin)
assert 'error' in d
assert 'not found' in d['error'].lower()
" && pass "/read 不存在文件返回 error" \
  || fail "/read 404 异常: $READ_404"

# 清理本地 server
kill $SERVER_PID 2>/dev/null || true
wait $SERVER_PID 2>/dev/null || true
rm -f /tmp/sandbox_test.txt
pass "Phase 1 完成: sandbox server 本地冒烟全部通过"

echo ""

# ====================================================================
# Phase 2: Docker 镜像构建 + 容器启动（需要 Docker daemon）
# ====================================================================
if ! command -v docker &> /dev/null; then
    info "Phase 2: 跳过（docker 命令不可用）"
    exit 0
fi

if ! docker info &> /dev/null 2>&1; then
    info "Phase 2: 跳过（Docker daemon 未运行）"
    exit 0
fi

info "Phase 2: Docker 镜像构建 + 容器冒烟测试"

# 2.1 构建镜像
info "构建 claw-eval-agent:latest ..."
docker build -f Dockerfile.agent -t claw-eval-agent:latest . -q \
    && pass "Docker 镜像构建成功" \
    || fail "Docker 镜像构建失败"

# 2.2 启动容器
CONTAINER_ID=$(docker run -d --rm -p 28080:8080 --name claw-sandbox-test claw-eval-agent:latest)
info "容器启动: $CONTAINER_ID"
sleep 3

# 2.3 health check
HEALTH=$(curl -s http://localhost:28080/health || echo '{}')
echo "$HEALTH" | python -c "import sys,json; d=json.load(sys.stdin); assert d.get('status')=='ok'" \
    && pass "容器 /health 返回 ok" \
    || fail "容器 /health 异常: $HEALTH"

# 2.4 exec inside container
EXEC_RESULT=$(curl -s -X POST http://localhost:28080/exec \
    -H 'Content-Type: application/json' \
    -d '{"command":"python --version"}')
echo "$EXEC_RESULT" | python -c "
import sys, json
d = json.load(sys.stdin)
assert d['exit_code'] == 0
assert 'Python' in d['stdout'] or 'Python' in d['stderr']
" && pass "容器内 /exec python --version" \
  || fail "容器 /exec 异常: $EXEC_RESULT"

# 2.5 隔离验证：容器内不含 grader/mock/scoring 代码
ISOLATION=$(curl -s -X POST http://localhost:28080/exec \
    -H 'Content-Type: application/json' \
    -d '{"command":"find / -name grader.py 2>/dev/null | head -5"}')
echo "$ISOLATION" | python -c "
import sys, json
d = json.load(sys.stdin)
assert d['stdout'].strip() == '', f'grader.py found: {d[\"stdout\"]}'
" && pass "隔离验证: 容器内无 grader.py" \
  || fail "隔离验证失败: $ISOLATION"

ISOLATION2=$(curl -s -X POST http://localhost:28080/exec \
    -H 'Content-Type: application/json' \
    -d '{"command":"find / -name \"*.yaml\" -path \"*/tasks/*\" 2>/dev/null | head -5"}')
echo "$ISOLATION2" | python -c "
import sys, json
d = json.load(sys.stdin)
assert d['stdout'].strip() == '', f'task YAML found: {d[\"stdout\"]}'
" && pass "隔离验证: 容器内无 task YAML" \
  || fail "隔离验证失败: $ISOLATION2"

# 2.6 write + read in container
curl -s -X POST http://localhost:28080/write \
    -H 'Content-Type: application/json' \
    -d '{"path":"/workspace/test_output.txt","content":"hello from host"}' > /dev/null

READ_CTR=$(curl -s -X POST http://localhost:28080/read \
    -H 'Content-Type: application/json' \
    -d '{"path":"/workspace/test_output.txt"}')
echo "$READ_CTR" | python -c "
import sys, json
d = json.load(sys.stdin)
assert d['content'] == 'hello from host'
" && pass "容器内 /write + /read" \
  || fail "容器 /write+/read 异常: $READ_CTR"

# 清理容器
docker stop claw-sandbox-test 2>/dev/null || true
pass "Phase 2 完成: Docker 容器冒烟全部通过"

echo ""

# ====================================================================
# Phase 3: Python API 冒烟（SandboxRunner）
# ====================================================================
info "Phase 3: SandboxRunner Python API 测试"

python -c "
import os
from claw_eval.runner.sandbox_runner import SandboxRunner, ContainerHandle
from claw_eval.config import SandboxConfig

cfg = SandboxConfig(enabled=True)
runner = SandboxRunner(cfg)

# start container
handle = runner.start_container(run_id='smoke-test')
print(f'  Container started at {handle.sandbox_url}')

# verify via HTTP
import httpx
resp = httpx.get(f'{handle.sandbox_url}/health', timeout=5)
assert resp.json()['status'] == 'ok', 'health check failed'
print('  Health check passed')

resp = httpx.post(f'{handle.sandbox_url}/exec', json={'command': 'whoami'}, timeout=5)
print(f'  whoami: {resp.json()[\"stdout\"].strip()}')

# verify proxy env vars are passed through
resp = httpx.post(f'{handle.sandbox_url}/exec', json={'command': 'env'}, timeout=5)
container_env = resp.json()['stdout']
host_proxy = os.environ.get('http_proxy', '')
if host_proxy:
    assert 'http_proxy' in container_env, f'http_proxy not in container env (host has: {host_proxy})'
    assert host_proxy in container_env, f'http_proxy value mismatch in container'
    print(f'  Proxy passthrough OK: http_proxy={host_proxy}')
else:
    print('  Host has no http_proxy, skipping passthrough check')

# stop container
runner.stop_container(handle)
print('  Container stopped')
" && pass "SandboxRunner start/stop + 代理透传" \
  || fail "SandboxRunner 测试失败"

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  全部测试通过!${NC}"
echo -e "${GREEN}========================================${NC}"
