"""
Surfpool process manager.

Handles starting, stopping, and managing Surfpool instances.
Surfpool provides a drop-in replacement for solana-test-validator
with enhanced capabilities like mainnet data fetching.
"""

import asyncio
import os
import shutil
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import aiohttp


@dataclass
class SurfpoolConfig:
    """Configuration for a Surfpool instance."""
    rpc_port: int = 8899
    ws_port: int = 8900
    faucet_port: int = 9900
    # Mock mode for testing without Surfpool installed
    mock_mode: bool = False
    # Offline mode - run without remote RPC (default for local testing)
    # When True, validation is skipped since no real programs exist
    offline_mode: bool = True
    # Clone programs from devnet/mainnet
    clone_from: Optional[str] = None  # "devnet" or "mainnet-beta"
    # Programs to clone
    programs_to_clone: list[str] = None
    # Accounts to pre-fund
    prefund_accounts: list[str] = None
    # Additional CLI args
    extra_args: list[str] = None
    
    def __post_init__(self):
        self.programs_to_clone = self.programs_to_clone or []
        self.prefund_accounts = self.prefund_accounts or []
        self.extra_args = self.extra_args or []
        # If cloning programs, disable offline mode
        if self.clone_from and self.programs_to_clone:
            self.offline_mode = False


class SurfpoolManager:
    """
    Manages Surfpool process lifecycle.
    
    Surfpool is started as a subprocess and provides a standard
    Solana RPC endpoint for transaction submission and queries.
    """

    def __init__(self, config: Optional[SurfpoolConfig] = None):
        """
        Initialize Surfpool manager.
        
        Args:
            config: Surfpool configuration (uses defaults if not provided)
        """
        self.config = config or SurfpoolConfig()
        self._process: Optional[subprocess.Popen] = None
        self._rpc_url: Optional[str] = None
        self._started = False

    @property
    def rpc_url(self) -> str:
        """Get the RPC URL for this Surfpool instance."""
        if not self._started:
            raise RuntimeError("Surfpool not started")
        return f"http://localhost:{self.config.rpc_port}"

    @property
    def ws_url(self) -> str:
        """Get the WebSocket URL for this Surfpool instance."""
        if not self._started:
            raise RuntimeError("Surfpool not started")
        return f"ws://localhost:{self.config.ws_port}"

    def _find_surfpool_binary(self) -> str:
        """Find the surfpool binary in PATH or common locations."""
        # Check PATH
        binary = shutil.which("surfpool")
        if binary:
            return binary
        
        # Check common install locations
        common_paths = [
            Path.home() / ".cargo" / "bin" / "surfpool",
            Path("/usr/local/bin/surfpool"),
            Path("/opt/homebrew/bin/surfpool"),
        ]
        
        for path in common_paths:
            if path.exists():
                return str(path)
        
        raise RuntimeError(
            "Surfpool binary not found. Install with: brew install txtx/taps/surfpool"
        )

    def _build_command(self) -> list[str]:
        """Build the surfpool start command."""
        cmd = [self._find_surfpool_binary(), "start"]
        
        # Port configuration (use -p/--port, not --rpc-port)
        cmd.extend(["--port", str(self.config.rpc_port)])
        
        # Run in non-interactive mode for automation
        cmd.append("--no-tui")
        
        # Run offline for local testing (no remote RPC needed)
        cmd.append("--offline")
        
        # Clone programs if specified
        if self.config.clone_from and self.config.programs_to_clone:
            # Remove --offline if we need to clone from remote
            cmd.remove("--offline")
            for program in self.config.programs_to_clone:
                cmd.extend(["--clone", program])
            cmd.extend(["--rpc-url", self.config.clone_from])
        
        # Add extra args
        cmd.extend(self.config.extra_args)
        
        return cmd

    async def start(self, timeout: float = 120.0) -> None:
        """
        Start Surfpool instance.
        
        Args:
            timeout: Seconds to wait for RPC to become available (default 120s)
            
        Raises:
            RuntimeError: If Surfpool fails to start
        """
        if self._started:
            return
        
        # Mock mode - simulate Surfpool without actually running it
        if self.config.mock_mode:
            print("       (running in mock mode - Surfpool simulated)")
            self._started = True
            return
        
        # Try to find Surfpool binary
        try:
            cmd = self._build_command()
        except RuntimeError as e:
            # Surfpool not found - ask user if they want mock mode
            raise RuntimeError(
                f"{e}\n\nAlternatively, add --mock flag to run without Surfpool"
            )
        
        print(f"       Starting: {' '.join(cmd)}")
        
        # Start process with stderr capture
        self._process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            preexec_fn=os.setsid if os.name != 'nt' else None,
        )
        
        # Wait for RPC to become available with progress updates
        start_time = time.time()
        last_log = start_time
        while time.time() - start_time < timeout:
            # Check if process died
            if self._process.poll() is not None:
                stderr = self._process.stderr.read().decode() if self._process.stderr else ""
                raise RuntimeError(f"Surfpool exited unexpectedly. stderr: {stderr}")
            
            if await self._check_rpc_ready():
                self._started = True
                return
            
            # Log progress every 10 seconds
            if time.time() - last_log > 10:
                elapsed = int(time.time() - start_time)
                print(f"       Waiting for Surfpool RPC... ({elapsed}s)")
                last_log = time.time()
            
            await asyncio.sleep(1.0)
        
        # Timeout - capture stderr and cleanup
        stderr = ""
        if self._process and self._process.stderr:
            stderr = self._process.stderr.read().decode()
        self.stop()
        raise RuntimeError(f"Surfpool failed to start within {timeout}s. stderr: {stderr}")

    async def _check_rpc_ready(self) -> bool:
        """Check if the RPC endpoint is responding."""
        try:
            async with aiohttp.ClientSession() as session:
                # First try getHealth
                async with session.post(
                    f"http://localhost:{self.config.rpc_port}",
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "getHealth",
                    },
                    timeout=aiohttp.ClientTimeout(total=2),
                ) as response:
                    if response.status == 200:
                        result = await response.json()
                        # Accept any valid JSON-RPC response with a result
                        if "result" in result:
                            return True
                        # Some implementations return error for getHealth if healthy
                        if "jsonrpc" in result:
                            return True
                
                # Fallback: try getVersion which is more widely supported
                async with session.post(
                    f"http://localhost:{self.config.rpc_port}",
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "getVersion",
                    },
                    timeout=aiohttp.ClientTimeout(total=2),
                ) as response:
                    if response.status == 200:
                        return True
        except Exception:
            pass
        return False

    def stop(self) -> None:
        """Stop the Surfpool instance."""
        if not self._process:
            return
        
        try:
            # Check if process is still running
            if self._process.poll() is not None:
                # Process already exited
                self._process = None
                self._started = False
                return
            
            # Try graceful shutdown first
            if os.name != 'nt':
                try:
                    os.killpg(os.getpgid(self._process.pid), signal.SIGTERM)
                except (ProcessLookupError, OSError):
                    pass  # Process already gone
            else:
                self._process.terminate()
            
            try:
                self._process.wait(timeout=5)
            except Exception:
                # Force kill if graceful shutdown failed
                if os.name != 'nt':
                    try:
                        os.killpg(os.getpgid(self._process.pid), signal.SIGKILL)
                    except (ProcessLookupError, OSError):
                        pass  # Process already gone
                else:
                    self._process.kill()
        finally:
            self._process = None
            self._started = False

    async def __aenter__(self) -> "SurfpoolManager":
        """Async context manager entry."""
        await self.start()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        """Async context manager exit."""
        self.stop()


class SolanaRpcClient:
    """
    Simple async Solana RPC client.
    
    Used to interact with Surfpool's RPC endpoint.
    """

    def __init__(self, rpc_url: str):
        """
        Initialize RPC client.
        
        Args:
            rpc_url: RPC endpoint URL
        """
        self.rpc_url = rpc_url
        self._request_id = 0

    async def _call(self, method: str, params: list = None) -> dict:
        """Make an RPC call."""
        self._request_id += 1
        payload = {
            "jsonrpc": "2.0",
            "id": self._request_id,
            "method": method,
            "params": params or [],
        }
        
        async with aiohttp.ClientSession() as session:
            async with session.post(self.rpc_url, json=payload) as response:
                result = await response.json()
                if "error" in result:
                    raise RuntimeError(f"RPC error: {result['error']}")
                return result.get("result")

    async def get_health(self) -> str:
        """Check node health."""
        return await self._call("getHealth")

    async def get_balance(self, pubkey: str) -> int:
        """Get account balance in lamports."""
        result = await self._call("getBalance", [pubkey])
        return result.get("value", 0)

    async def request_airdrop(self, pubkey: str, lamports: int) -> str:
        """Request airdrop (only works on localnet/devnet)."""
        return await self._call("requestAirdrop", [pubkey, lamports])

    async def send_transaction(self, signed_tx: str, options: dict = None) -> str:
        """Send a signed transaction."""
        params = [signed_tx]
        if options:
            params.append(options)
        return await self._call("sendTransaction", params)

    async def get_latest_blockhash(self) -> dict:
        """Get latest blockhash."""
        return await self._call("getLatestBlockhash")

    async def get_account_info(self, pubkey: str) -> dict:
        """Get account info."""
        return await self._call("getAccountInfo", [pubkey, {"encoding": "base64"}])

    async def simulate_transaction(self, tx: str, options: dict = None) -> dict:
        """Simulate a transaction."""
        params = [tx]
        if options:
            params.append(options)
        return await self._call("simulateTransaction", params)

    async def get_signature_statuses(self, signatures: list[str]) -> list:
        """Get status of transaction signatures."""
        result = await self._call("getSignatureStatuses", [signatures])
        return result.get("value", [])
