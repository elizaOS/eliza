import logging
import subprocess
import json
import os
from typing import List

import voyager.utils as U
from langchain_openai import ChatOpenAI

class TypeScriptSkillManager:
    def __init__(
        self, 
        model_name,
        temperature=0,
        retrieval_top_k=5,
        request_timeout=120,
        ckpt_dir="ckpt",
        resume=False
    ):
        self.llm = ChatOpenAI(
            base_url="https://openrouter.ai/api/v1",
            model=model_name,
            temperature=temperature,
            request_timeout=request_timeout,
            api_key=os.getenv("OPENROUTER_API_KEY"),
        )
        U.f_mkdir(f"{ckpt_dir}/skill/code")
        U.f_mkdir(f"{ckpt_dir}/skill/description")
        if resume:
            logging.info(
               f"\033[33mLoading Skill Manager from {ckpt_dir}/skill\033[0m" 
            )
            self.skills = U.load_json(f"{ckpt_dir}/skill/skills.json")
        else:
            self.skills = {}
        self.retrieval_top_k = retrieval_top_k
        self.ckpt_dir = ckpt_dir        

    # ================================
    # Code Loop

    def run_code_loop_code(self, code: str, agent_pubkey: str, latest_blockhash: str, code_file: str = "voyager/skill_runner/code_loop_code.ts", timeout: int = 30000):
        with open(code_file, "w") as f:
            f.write(code)
        command = ["bun", "voyager/skill_runner/runSkill.ts", code_file, str(timeout), agent_pubkey, latest_blockhash]
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                check=True,
                encoding='utf-8'
            )
            # parse the last line of the output
            return json.loads(result.stdout.strip("\n").split("\n")[-1])
        except subprocess.CalledProcessError as e:
            # When there's an error, runSkill.ts prints JSON to stdout and error details to stderr
            try:
                # Try to parse the JSON output from stdout (this has the structured error info)
                if e.stdout:
                    error_data = json.loads(e.stdout.strip("\n").split("\n")[-1])
                    # Also capture stderr for full error details
                    if e.stderr:
                        error_data['stderr'] = e.stderr
                    return error_data
                elif e.stderr:
                    # Fallback if only stderr is available
                    return {"success": False, "reason": f"Skill runner error", "stderr": e.stderr}
            except json.JSONDecodeError:
                # Fallback for unexpected output
                return {
                    "success": False, 
                    "reason": "Skill runner error",
                    "stdout": e.stdout if e.stdout else "",
                    "stderr": e.stderr if e.stderr else ""
                }
        except FileNotFoundError:
            return {"success": False, "reason": "Bun command not found. Make sure Bun is installed and in your PATH."}