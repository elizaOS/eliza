"""Boot the candidate's real HTTP/runtime stack and assert missing vision fails."""
import json
import os
import re
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import urllib.error
import urllib.request

def interrupted(_signum, _frame):
    raise KeyboardInterrupt("HTTP fixture interrupted")


signal.signal(signal.SIGTERM, interrupted)

root = Path(os.environ['BENCHMARK_VISION_TEST_OUTPUT'])
root.mkdir(parents=True, exist_ok=True)
server_entry = Path(os.environ['BENCHMARK_VISION_SERVER_ENTRY'])
invalid_agent = '--invalid-agent' in sys.argv
visualwebbench = '--visualwebbench' in sys.argv
positive = '--positive' in sys.argv or invalid_agent or visualwebbench
provider_requests = []
class Provider(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'data': [{'id': 'vision-test'}]}).encode())
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        provider_requests.append(body)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        tools = [t.get('function', {}).get('name') for t in body.get('tools', [])]
        if 'HANDLE_RESPONSE' in tools and not invalid_agent:
            source = re.search(r'completion_source_set.{0,30}?([0-9a-f]{64})', json.dumps(body.get('messages', [])))
            args = {'shouldRespond': 'RESPOND', 'contexts': [], 'contextRequests': [], 'intents': [], 'completionContext': {'mode': 'all_prior_dialogue', 'sourceSetId': source.group(1) if source else '', 'complete': True, 'relevantSourceIds': [], 'constraintSourceIds': [], 'referentSourceIds': [], 'pendingIntentSourceIds': []}, 'replyText': 'WAIT', 'replyEffectStatus': 'none', 'candidateActionNames': [], 'facts': [], 'relationships': [], 'topics': [], 'addressedTo': [], 'emotion': 'none'}
            message = {'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'response-fixture', 'type': 'function', 'function': {'name': 'HANDLE_RESPONSE', 'arguments': json.dumps(args)}}]}
            finish = 'tool_calls'
        elif body.get('model') == 'vision-test':
            message = {'role': 'assistant', 'content': json.dumps({'title': 'Pixel', 'description': 'A visible pixel.', 'text': 'One complete pixel image.'})}
            finish = 'stop'
        else:
            message = {'role': 'assistant', 'content': 'WAIT'}
            finish = 'stop'
        self.wfile.write(json.dumps({'id': 'vision-test-response', 'model': body.get('model'), 'choices': [{'index': 0, 'finish_reason': finish, 'message': message}], 'usage': {'prompt_tokens': 11, 'completion_tokens': 7, 'total_tokens': 18}}).encode())
    def log_message(self, *args):
        pass
provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
Thread(target=provider.serve_forever, daemon=True).start()
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
env = dict(os.environ)
env.update({
    'ELIZA_BENCH_PORT': str(port), 'ELIZA_BENCH_HOST': '127.0.0.1',
    'ELIZA_BENCH_TOKEN': 'vision-transport-diagnostic',
    'ELIZA_BENCH_MOCK': 'true', 'ELIZA_BENCH_SKIP_CORE_PLUGINS': 'true',
    'ELIZA_BENCH_SKIP_ELIZA_PLUGIN': 'true', 'ELIZA_BENCH_ALLOW_STUB_EMBEDDING': '1',
    'DISABLE_IMAGE_DESCRIPTION': 'true', 'BENCHMARK_MODEL_PROVIDER': 'mock',
    'ELIZA_PROVIDER': 'mock',
})
for key in ('CEREBRAS_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'):
    env[key] = ''
if positive:
    env.update({'OPENAI_API_KEY': 'diagnostic-local-key', 'OPENAI_BASE_URL': f'http://127.0.0.1:{provider.server_port}/v1', 'OPENAI_IMAGE_DESCRIPTION_MODEL': 'vision-test', 'DISABLE_IMAGE_DESCRIPTION': 'false'})
log_path = root / ('http-invalid-agent-server.log' if invalid_agent else 'http-positive-server.log' if positive else 'http-server.log')
with tempfile.TemporaryDirectory(prefix='vision-http-state-') as state, log_path.open('w') as log:
    env['ELIZA_STATE_DIR'] = state
    process = subprocess.Popen(['node', '--conditions=eliza-source', '--conditions=development', '--import', 'tsx', str(server_entry)], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        url = f'http://127.0.0.1:{port}/api/benchmark/'
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f'server exited {process.returncode}; see http-server.log')
            try:
                urllib.request.urlopen(url+'health', timeout=1).close()
                break
            except (urllib.error.URLError, TimeoutError):
                time.sleep(.25)
        else:
            raise TimeoutError('Server startup exceeded90seconds')
        payload = {'text': 'Inspect this screenshot.', 'context': {'benchmark': 'osworld', 'task_id': 'vision-negative', 'screenshot_base64': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC'}}
        image_base64 = payload['context']['screenshot_base64']
        if visualwebbench:
            payload['context'] = {'benchmark': 'visual-web-bench', 'task_id': 'vision-vwb', 'attachments': [{'kind': 'image', 'media_type': 'image/png', 'data_base64': image_base64}]}
        request = urllib.request.Request(url+'message', data=json.dumps(payload).encode(), headers={'Authorization': 'Bearer vision-transport-diagnostic', 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                status, body = response.status, response.read().decode()
        except urllib.error.HTTPError as error:
            status, body = error.code, error.read().decode()
        log.flush()
        if invalid_agent:
            assert status == 500, (status, body)
            assert 'Native benchmark agent turn did not complete' in log_path.read_text()
            (root/'http-invalid-agent-receipt.json').write_text(json.dumps({'status': status, 'response': json.loads(body), 'failed_native_turn_rejected': True, 'release_evidence': False}, indent=2)+'\n')
            print('PASS: failed native agent turn returns500 instead of an apparently successful apology.')
        elif positive:
            assert status == 200, (status, body)
            response = json.loads(body)
            assert response['metadata']['native_runtime_api'] == 'messageService.handleMessage', response
            assert response['outcome']['status'] == 'completed', response
            images = [part['image_url']['url'] for call in provider_requests for message in call.get('messages', []) for part in message.get('content', []) if isinstance(part, dict) and part.get('type') == 'image_url']
            assert images == ['data:image/png;base64,' + image_base64], images
            assert response['usage']['totalTokens'] >= 18, response['usage']
            assert response['metadata']['image_input_mode'] == 'native_image_description'
            assert response['metadata']['image_model_usage'][0]['model'] == 'vision-test'
            assert any(call['model'] == 'vision-test' for call in provider_requests), provider_requests
            (root/'http-positive-receipt.json').write_text(json.dumps({'status': status, 'response': response, 'exact_image_bytes_delivered': True, 'diagnostic_mock_runtime': True, 'release_evidence': False}, indent=2)+'\n')
            print('PASS: real HTTP runtime and OpenAI provider deliver exact image bytes and capture image token usage; deterministic local provider, no live quality claim.')
        else:
            assert status == 500, (status, body)
            assert 'requires a configured native image-description provider' in log_path.read_text()
            (root/'http-receipt.json').write_text(json.dumps({'status': status, 'response': json.loads(body), 'vision_disabled_rejected': True, 'diagnostic_mock_runtime': True, 'release_evidence': False}, indent=2)+'\n')
            print('PASS: real HTTP server returns500 and records missing-vision error; diagnostic runtime, no model-quality claim.')
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        (root/"provider-request-shapes.json").write_text(json.dumps([{k:v for k,v in r.items() if k != "messages"} for r in provider_requests], indent=2))
        provider.shutdown()
        provider.server_close()
