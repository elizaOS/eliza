import json
import os
from typing import Dict, Tuple, List
import numpy as np
from sklearn.metrics.pairwise import cosine_similarity
from ..utils.common_utils import (
    load_embeddings,
    load_knowledge_base,
    save_embeddings,
)
from ..tools.new_tools import NewTools
from .mllm import CostManager

def get_embedding_dim(model_name):
    if model_name == "doubao-embedding-large-text-250515":
        return 2048
    elif model_name == "doubao-embedding-text-240715":
        return 2560
    elif model_name == "text-embedding-ada-002":
        return 1536
    elif model_name == "text-embedding-3-small":
        return 1536
    elif model_name == "text-embedding-3-large":
        return 3072
    elif model_name == "gemini-embedding-001":
        return 3072
    elif model_name == "jina-embeddings-v4":
        return 2048
    elif model_name == "jina-embeddings-v3":
        return 1024
    elif model_name == "text-embedding-v4":
        return 1024
    elif model_name == "text-embedding-v3":
        return 1024
    elif model_name == "embedding-2" or model_name == "embedding-3":
        return 2048
    else:
        return None

class NewKnowledgeBase:
    def __init__(
        self,
        embedding_engine: NewTools,
        local_kb_path: str,
        platform: str,
        Tools_dict: Dict,
        save_knowledge: bool = True,
    ):
        """
        Initialize the KnowledgeBase module
        
        Args:
            embedding_engine: Embedding engine instance
            local_kb_path: Path to local knowledge base
            platform: Target platform (Windows/Darwin/Ubuntu)
            Tools_dict: Dictionary containing tool configurations
            save_knowledge: Whether to save knowledge embeddings
        """
        self.platform = platform

        self.local_kb_path = local_kb_path

        # initialize embedding engine
        self.embedding_engine = embedding_engine

        # Initialize paths for different memory types
        self.episodic_memory_path = os.path.join(
            self.local_kb_path, self.platform, "episodic_memory.json"
        )
        self.narrative_memory_path = os.path.join(
            self.local_kb_path, self.platform, "narrative_memory.json"
        )
        embedding_model_name = ""
        if hasattr(self.embedding_engine, "tools") and "embedding" in self.embedding_engine.tools:
            embedding_model_name = self.embedding_engine.tools["embedding"].model_name
        else:
            embedding_model_name = "default"
        embedding_dim = get_embedding_dim(embedding_model_name)
        self.embeddings_path = os.path.join(
            self.local_kb_path, self.platform, f"embeddings_{embedding_model_name}_{embedding_dim}.pkl"
        )

        # Initialize trajectory tracking
        self.task_trajectory = ""
        self.current_subtask_trajectory = ""
        self.current_search_query = ""
        
        # query_formulator
        self.query_formulator_name = "query_formulator"
        self.query_formulator = NewTools()
        self.query_formulator.register_tool(
            self.query_formulator_name,
            Tools_dict[self.query_formulator_name]["provider"],
            Tools_dict[self.query_formulator_name]["model"],
        )
        
        # knowledge_fusion_agent
        self.knowledge_fusion_agent_name = "context_fusion"
        self.knowledge_fusion_agent = NewTools()
        self.knowledge_fusion_agent.register_tool(
            self.knowledge_fusion_agent_name,
            Tools_dict[self.knowledge_fusion_agent_name]["provider"],
            Tools_dict[self.knowledge_fusion_agent_name]["model"],
        )

        # narrative_summarization_agent
        self.narrative_summarization_agent_name = "narrative_summarization"
        self.narrative_summarization_agent = NewTools()
        self.narrative_summarization_agent.register_tool(
            self.narrative_summarization_agent_name,
            Tools_dict[self.narrative_summarization_agent_name]["provider"],
            Tools_dict[self.narrative_summarization_agent_name]["model"],
        )
        
        # episode_summarization_agent
        self.episode_summarization_agent_name = "episode_summarization"
        self.episode_summarization_agent = NewTools()
        self.episode_summarization_agent.register_tool(
            self.episode_summarization_agent_name,
            Tools_dict[self.episode_summarization_agent_name]["provider"],
            Tools_dict[self.episode_summarization_agent_name]["model"],
        )

        self.save_knowledge = save_knowledge

    def retrieve_knowledge(
        self, instruction: str, search_query: str, search_engine: NewTools
    ) -> Tuple[str, List[int], str]:
        """Retrieve knowledge using search engine
        Args:
            instruction (str): task instruction
            search_query (str): search query to use
            search_engine (NewTools): search engine tool to use
            
        Returns:
            Tuple[str, List[int], float]: The search results, token usage, and cost
        """
        search_results, total_tokens, cost_string = search_engine.execute_tool("websearch", {"str_input": instruction + " " + search_query})

        return search_results, total_tokens, cost_string

    def formulate_query(self, instruction: str, observation: Dict) -> Tuple[str, List[int], str]:
        """Formulate search query based on instruction and current state
        
        Args:
            instruction (str): The task instruction
            observation (Dict): Current observation including screenshot
            
        Returns:
            Tuple[str, List[int], float]: The formulated query, token usage, and cost
        """
        query_path = os.path.join(
            self.local_kb_path, self.platform, "formulate_query.json"
        )
        try:
            with open(query_path, "r") as f:
                formulate_query = json.load(f)
        except:
            formulate_query = {}

        if instruction in formulate_query:
            return formulate_query[instruction], [0, 0, 0], ""

        self.query_formulator.tools["query_formulator"].llm_agent.reset()

        content, total_tokens, cost_string = self.query_formulator.execute_tool("query_formulator", {
            "str_input": f"The task is: {instruction}\n" + 
                "To use google search to get some useful information, first carefully analyze " + 
                "the screenshot of the current desktop UI state, then given the task " + 
                "instruction, formulate a question that can be used to search on the Internet " + 
                "for information in helping with the task execution.\n" + 
                "The question should not be too general or too specific. Please ONLY provide " + 
                "the question.\nQuestion:",
            "img_input": observation["screenshot"] if "screenshot" in observation else None
        })
        
        search_query = content.strip().replace('"', "")
    
        # print("search query: ", search_query)
        formulate_query[instruction] = search_query
        with open(query_path, "w") as f:
            json.dump(formulate_query, f, indent=2)

        return search_query, total_tokens, cost_string

    def retrieve_narrative_experience(self, instruction: str) -> Tuple[str, str, List[int], str]:
        """Retrieve narrative experience using embeddings
        
        Args:
            instruction (str): The task instruction
            
        Returns:
            Tuple[str, str]: The similar task key and its narrative experience
        """

        knowledge_base = load_knowledge_base(self.narrative_memory_path)
        if not knowledge_base:
            return "None", "None", [0, 0, 0], ""

        embeddings = load_embeddings(self.embeddings_path)

        # Get or create instruction embedding
        instruction_embedding = embeddings.get(instruction)
        total_tokens, cost_string = [0, 0, 0], ""

        if instruction_embedding is None:
            instruction_embedding, tokens, cost_string_now = self.embedding_engine.execute_tool("embedding", {"str_input": instruction})
            embeddings[instruction] = instruction_embedding
            # total_tokens += tokens
            for i in range(len(total_tokens)):
                total_tokens[i] += tokens[i]
            cost_string = cost_string_now
        # Get or create embeddings for knowledge base entries
        candidate_embeddings = []
        for key in knowledge_base:
            candidate_embedding = embeddings.get(key)
            if candidate_embedding is None:
                candidate_embedding, tokens, cost_string_now = self.embedding_engine.execute_tool("embedding", {"str_input": key})
                for i in range(len(tokens)):
                    total_tokens[i] += tokens[i]
                # total_tokens += tokens
                cost_string = CostManager.add_costs(cost_string, cost_string_now)
            embeddings[key] = candidate_embedding

            candidate_embeddings.append(candidate_embedding)

        save_embeddings(self.embeddings_path, embeddings)

        similarities = cosine_similarity(
            instruction_embedding, np.vstack(candidate_embeddings)
        )[0]
        sorted_indices = np.argsort(similarities)[::-1]

        keys = list(knowledge_base.keys())
        idx = 1 if keys[sorted_indices[0]] == instruction else 0
        return keys[sorted_indices[idx]], knowledge_base[keys[sorted_indices[idx]]], total_tokens, cost_string

    def retrieve_episodic_experience(self, instruction: str) -> Tuple[str, str, List[int], str]:
        """Retrieve similar task experience using embeddings
        
        Args:
            instruction (str): The task instruction
            
        Returns:
            Tuple[str, str]: The similar task key and its episodic experience
        """

        knowledge_base = load_knowledge_base(self.episodic_memory_path)
        if not knowledge_base:
            return "None", "None", [0, 0, 0], ""

        embeddings = load_embeddings(self.embeddings_path)

        # Get or create instruction embedding
        instruction_embedding = embeddings.get(instruction)
        total_tokens, cost_string = [0, 0, 0], ""

        if instruction_embedding is None:
            instruction_embedding, tokens, cost_string_now = self.embedding_engine.execute_tool("embedding", {"str_input": instruction})
            embeddings[instruction] = instruction_embedding

            # total_tokens += tokens
            for i in range(len(total_tokens)):
                total_tokens[i] += tokens[i]
            cost_string = cost_string_now

        # Get or create embeddings for knowledge base entries
        candidate_embeddings = []
        for key in knowledge_base:
            candidate_embedding = embeddings.get(key)
            if candidate_embedding is None:
                candidate_embedding, tokens, cost_string_now = self.embedding_engine.execute_tool("embedding", {"str_input": key})
                # total_tokens += tokens
                for i in range(len(total_tokens)):
                    total_tokens[i] += tokens[i]
                cost_string = CostManager.add_costs(cost_string, cost_string_now)
            embeddings[key] = candidate_embedding

            candidate_embeddings.append(candidate_embedding)

        save_embeddings(self.embeddings_path, embeddings)

        similarities = cosine_similarity(
            instruction_embedding, np.vstack(candidate_embeddings)
        )[0]
        sorted_indices = np.argsort(similarities)[::-1]

        keys = list(knowledge_base.keys())
        idx = 1 if keys[sorted_indices[0]] == instruction else 0
        return keys[sorted_indices[idx]], knowledge_base[keys[sorted_indices[idx]]], total_tokens, cost_string

    def knowledge_fusion(
        self,
        observation: Dict,
        instruction: str,
        web_knowledge: str,
        similar_task: str,
        experience: str,
    ) -> Tuple[str, list, str]:
        """Combine web knowledge with similar task experience"""

        content, total_tokens, cost = self.knowledge_fusion_agent.execute_tool("context_fusion", {
            "str_input": f"Task: {instruction}\n" + 
                f"**Web search result**:\n{web_knowledge}\n\n" + 
                f"**Retrieved similar task experience**:\n" + 
                f"Similar task:{similar_task}\n{experience}\n\n" + 
                f"Based on the web search result and the retrieved similar task experience, " + 
                f"if you think the similar task experience is indeed useful to the main task, " + 
                f"integrate it with the web search result. Provide the final knowledge in a numbered list.",
            "img_input": observation["screenshot"] if "screenshot" in observation else None
        })
        
        return content, total_tokens, cost
        

    def save_episodic_memory(self, subtask_key: str, subtask_traj: str) -> None:
        """Save episodic memory (subtask level knowledge).

        Args:
            subtask_key (str): Key identifying the subtask
            subtask_traj (str): Trajectory/experience of the subtask
        """
        if not self.save_knowledge:
            return

        try:
            kb = load_knowledge_base(self.episodic_memory_path)
        except:
            kb = {}

        if subtask_key not in kb:
            subtask_summarization = self.summarize_episode(subtask_traj)
            kb[subtask_key] = subtask_summarization

            if self.save_knowledge:
                os.makedirs(os.path.dirname(self.episodic_memory_path), exist_ok=True)
                with open(self.episodic_memory_path, "w") as fout:
                    json.dump(kb, fout, indent=2)

        return kb.get(subtask_key)

    def save_narrative_memory(self, task_key: str, task_traj: str) -> None:
        """Save narrative memory (task level knowledge).

        Args:
            task_key (str): Key identifying the task
            task_traj (str): Full trajectory/experience of the task
        """
        if not self.save_knowledge:
            return

        try:
            kb = load_knowledge_base(self.narrative_memory_path)
        except:
            kb = {}

        if task_key not in kb:
            task_summarization = self.summarize_narrative(task_traj)
            kb[task_key] = task_summarization

            if self.save_knowledge:
                os.makedirs(os.path.dirname(self.narrative_memory_path), exist_ok=True)
                with open(self.narrative_memory_path, "w") as fout:
                    json.dump(kb, fout, indent=2)

        return kb.get(task_key)

    def initialize_task_trajectory(self, instruction: str) -> None:
        """Initialize a new task trajectory.

        Args:
            instruction (str): The task instruction
        """
        self.task_trajectory = f"Task:\n{instruction}"
        self.current_search_query = ""
        self.current_subtask_trajectory = ""

    def update_task_trajectory(self, meta_data: Dict) -> None:
        """Update the task trajectory with new metadata.

        Args:
            meta_data (Dict): Metadata from the agent's prediction
        """
        if not self.current_search_query and "search_query" in meta_data:
            self.current_search_query = meta_data["search_query"]

        self.task_trajectory += (
            "\n\nReflection:\n"
            + str(meta_data["reflection"])
            + "\n\n----------------------\n\nPlan:\n"
            + meta_data["executor_plan"]
        )

    def handle_subtask_trajectory(self, meta_data: Dict):
        """Handle subtask trajectory updates based on subtask status.

        Args:
            meta_data (Dict): Metadata containing subtask information

        Returns:
            bool: Whether the subtask was completed
        """
        subtask_status = meta_data["subtask_status"]
        subtask = meta_data["subtask"]
        subtask_info = meta_data["subtask_info"]

        if subtask_status in ["Start", "Done"]:
            # If there's an existing subtask trajectory, finalize it
            if self.current_subtask_trajectory:
                self.current_subtask_trajectory += "\nSubtask Completed.\n"
                subtask_key = self.current_subtask_trajectory.split(
                    "\n----------------------\n\nPlan:\n"
                )[0]
                self.save_episodic_memory(subtask_key, self.current_subtask_trajectory)
                self.current_subtask_trajectory = ""
                return True

            # Start new subtask trajectory
            self.current_subtask_trajectory = (
                f"Task:\n{self.current_search_query}\n\n"
                f"Subtask: {subtask}\n"
                f"Subtask Instruction: {subtask_info}\n"
                f"----------------------\n\n"
                f'Plan:\n{meta_data["executor_plan"]}\n'
            )
            return False

        elif subtask_status == "In":
            # Continue current subtask trajectory
            self.current_subtask_trajectory += (
                f'\n----------------------\n\nPlan:\n{meta_data["executor_plan"]}\n'
            )
            return False

    def finalize_task(self) -> None:
        """Finalize the task by saving any remaining trajectories."""
        # Save any remaining subtask trajectory
        if self.current_subtask_trajectory:
            self.current_subtask_trajectory += "\nSubtask Completed.\n"
            subtask_key = self.current_subtask_trajectory.split(
                "\n----------------------\n\nPlan:\n"
            )[0]
            self.save_episodic_memory(subtask_key, self.current_subtask_trajectory)

        # Save the complete task trajectory
        if self.task_trajectory and self.current_search_query:
            self.save_narrative_memory(self.current_search_query, self.task_trajectory)

        # Reset trajectories
        self.task_trajectory = ""
        self.current_subtask_trajectory = ""
        self.current_search_query = ""

    def summarize_episode(self, trajectory: str) -> Tuple[str, List[int], str]:
        """Summarize the episode experience for lifelong learning reflection
        
        Args:
            trajectory (str): The episode experience to be summarized
            
        Returns:
            str: The summarized episode experience
        """

        # Create Reflection on whole trajectories for next round trial, keep earlier messages as exemplars
        content, total_tokens, cost = self.episode_summarization_agent.execute_tool("episode_summarization", {"str_input": trajectory})

        return content, total_tokens, cost

    def summarize_narrative(self, trajectory: str) -> Tuple[str, List[int], str]:
        """Summarize the narrative experience for lifelong learning reflection
        
        Args:
            trajectory (str): The narrative experience to be summarized
            
        Returns:
            str: The summarized narrative experience
        """
        # Create Reflection on whole trajectories for next round trial
        content, total_tokens, cost = self.narrative_summarization_agent.execute_tool("narrative_summarization", {"str_input": trajectory})

        return content, total_tokens, cost
