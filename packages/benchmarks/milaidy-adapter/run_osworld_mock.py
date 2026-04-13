
import logging
import base64
import json
import time
import os
import sys

# Add millaidy-adapter to path
sys.path.append(os.path.dirname(__file__))

from milady_adapter.server_manager import MiladyServerManager
from milady_adapter.client import MiladyClient
# We import our new adapter logic manually since we aren't using the full OSWorld suite here
# But we can use the class we just wrote if we fix imports in it
# For the mock, we can just use MiladyClient directly to simulate the agent loop

def create_mock_observation():
    # Create a simple black 100x100 image
    from PIL import Image
    from io import BytesIO
    
    img = Image.new('RGB', (100, 100), color = 'black')
    buffered = BytesIO()
    img.save(buffered, format="PNG")
    img_str = base64.b64encode(buffered.getvalue()).decode('utf-8')
    
    return {
        "screenshot": img_str,
        "accessibility_tree": "tag\tname\ttext\tclass\tdescription\tposition\tsize\nbutton\tSubmit\tSubmit\tButton\t\t10,10\t50,20"
    }

def run_mock_benchmark():
    logging.basicConfig(level=logging.INFO)
    logger = logging.getLogger("mock_bench")
    
    # Configure env to enable computer use plugin if needed
    env = os.environ.copy()
    
    # Set env vars globally so MiladyServerManager picks them up
    os.environ["MILADY_ENABLE_COMPUTERUSE"] = "true"
    os.environ["MILADY_BENCH_PORT"] = "3939"
    os.environ["PGLITE_DATA_DIR"] = ":memory:" # Force in-memory DB for plugin-sql
    # os.environ["MILADY_BENCH_MOCK"] = "true" # Disable mock for real test  
    # Calculate repo root from this script's location
    # run_osworld_mock.py is in benchmarks/milady-adapter/
    # repo root (eliza-workspace) is ../../
    from pathlib import Path
    repo_root = Path(__file__).resolve().parent.parent.parent
    
    logger.info(f"Starting Milady Benchmark Server from {repo_root}...")
    mgr = MiladyServerManager(repo_root=repo_root)
    
    try:
        mgr.start()
        
        # Create client
        client = mgr.client
        
        # Sample context from OSWorld
        # We need to construct a valid observation
        context = {
            "observation": {
                "screenshot": "base64_screenshot_placeholder",
                "accessibility_tree": "<html><body><button id='1'>Submit</button></body></html>",
                "som": { "1": [10, 10, 50, 20] } # Simulated SOM coordinates
            }
        }
        
        logger.info("Sending message to agent...")
        resp = client.send_message(
            text="Please click the Submit button.",
            context=context
        )
        
        logger.info(f"Agent response: {resp}")
        
        # Verify response contains BENCHMARK_ACTION
        # MiladyAdapter response object has: text, thought, actions?, params?
        # The client returns whatever the server sends, parsed into an object.
        # Let's verify what we get.
        
        if resp.params:
            logger.info("✅ SUCCESS: Agent returned actions/params.")
            
            # Check if it tried to click
            if "command" in resp.params and "CLICK" in str(resp.params["command"]):
                 logger.info("✅ SUCCESS: Agent generated a CLICK command.")
            elif "tool_name" in resp.params:
                 logger.info(f"✅ SUCCESS: Agent called tool {resp.params['tool_name']}")
            elif "BENCHMARK_ACTION" in str(resp.params):
                 logger.info("✅ SUCCESS: Agent output BENCHMARK_ACTION (raw).")
            else:
                 logger.warning(f"⚠️ Agent returned params but no obvious click command: {resp.params}")

        else:
            logger.error("❌ FAILURE: No params returned.")
            if resp.text:
                logger.info(f"Agent reply text: {resp.text}")

    except Exception as e:
        logger.error(f"❌ ERROR: {e}")
        import traceback
        traceback.print_exc()
    finally:
        logger.info("Stopping server...")
        mgr.stop()

if __name__ == "__main__":
    run_mock_benchmark()
