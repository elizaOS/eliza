# Copyright 2025 AxonRL Team. All Rights Reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.


from gem.envs.registration import register

# Register games from our implementation of TextArena and beyond.
# GuessTheNumber

register(
    "canvas:CanvasListTestS2L-v0",
    "gem.envs.canvas_list_test_s2l:CanvasListTestS2LEnv",
    num_courses=10,
    submission_prob=0.0,
    exemption_prob=0.0,
    exemption_meet_prob=0.0,
)


register(
    "game:GuessTheNumber-v0-hard",
    "gem.envs.game_env.guess_the_number:GuessTheNumberEnv",
    min_number=1,
    max_number=50,
    max_turns=7,
)
register(
    "game:GuessTheNumber-v0-easy",
    "gem.envs.game_env.guess_the_number:GuessTheNumberEnv",
    min_number=1,
    max_number=10,
    max_turns=4,
)
register(
    "game:GuessTheNumber-v0-random",
    "gem.envs.game_env.guess_the_number:GuessTheNumberEnv",
    min_number=None,
    max_number=None,
    max_turns=None,
)
# Mastermind
register(
    "game:Mastermind-v0-hard",
    "gem.envs.game_env.mastermind:MastermindEnv",
    code_length=4,
    num_numbers=8,
    max_turns=30,
    duplicate_numbers=False,
)
register(
    "game:Mastermind-v0-random",
    "gem.envs.game_env.mastermind:MastermindEnv",
    code_length=None,
    num_numbers=None,
    max_turns=None,
    duplicate_numbers=False,
)
register(
    "game:Mastermind-v0-easy",
    "gem.envs.game_env.mastermind:MastermindEnv",
    code_length=2,
    num_numbers=6,
    max_turns=10,
    duplicate_numbers=False,
)
# Minesweeper
register(
    "game:Minesweeper-v0-easy",
    "gem.envs.game_env.minesweeper:MinesweeperEnv",
    rows=5,
    cols=5,
    num_mines=5,
    max_turns=25,
)
register(
    "game:Minesweeper-v0-hard",
    "gem.envs.game_env.minesweeper:MinesweeperEnv",
    rows=8,
    cols=8,
    num_mines=12,
    max_turns=64,
)
register(
    "game:Minesweeper-v0-random",
    "gem.envs.game_env.minesweeper:MinesweeperEnv",
    rows=None,
    cols=None,
    num_mines=None,
    max_turns=None,
)
# Wordle
register(
    "game:Wordle-v0-hard",
    "gem.envs.game_env.wordle:WordleEnv",
    word_length=5,
    only_real_words=True,
    max_turns=25,
)
register(
    "game:Wordle-v0-easy",
    "gem.envs.game_env.wordle:WordleEnv",
    word_length=3,
    only_real_words=True,
    max_turns=15,
)
register(
    "game:Wordle-v0-random",
    "gem.envs.game_env.wordle:WordleEnv",
    word_length=None,
    only_real_words=True,
    max_turns=None,
)
# FifteenPuzzle
register(
    "game:FifteenPuzzle-v0-random",
    "gem.envs.game_env.fifteen_puzzle:FifteenPuzzleEnv",
    num_rows=None,
    max_turns=None,
)
register(
    "game:FifteenPuzzle-v0-easy",
    "gem.envs.game_env.fifteen_puzzle:FifteenPuzzleEnv",
    num_rows=2,
    max_turns=10,
)
register(
    "game:FifteenPuzzle-v0-hard",
    "gem.envs.game_env.fifteen_puzzle:FifteenPuzzleEnv",
    num_rows=4,
    max_turns=50,
)
# Hangman
register(
    "game:Hangman-v0-random",
    "gem.envs.game_env.hangman:HangmanEnv",
    word_length=None,
    hardcore=False,
    max_turns=None,
)
register(
    "game:Hangman-v0-easy",
    "gem.envs.game_env.hangman:HangmanEnv",
    word_length=3,
    hardcore=False,
    max_turns=10,
)
register(
    "game:Hangman-v0-hard",
    "gem.envs.game_env.hangman:HangmanEnv",
    word_length=7,
    hardcore=False,
    max_turns=20,
)
# Sudoku
register(
    "game:Sudoku-v0-easy",
    "gem.envs.game_env.sudoku:SudokuEnv",
    clues=10,
    max_turns=15,
    scale=4,
)
register(
    "game:Sudoku-v0-hard",
    "gem.envs.game_env.sudoku:SudokuEnv",
    clues=50,
    max_turns=50,
    scale=9,
)
register(
    "game:Sudoku-v0-random",
    "gem.envs.game_env.sudoku:SudokuEnv",
    clues=None,
    max_turns=None,
    scale=None,
)
# Tower of Hanoi
register(
    "game:TowerofHanoi-v0-easy",
    "gem.envs.game_env.tower_of_hanoi:TowerofHanoiEnv",
    num_disks=3,
    max_turns=10,
)
register(
    "game:TowerofHanoi-v0-hard",
    "gem.envs.game_env.tower_of_hanoi:TowerofHanoiEnv",
    num_disks=5,
    max_turns=35,
)
register(
    "game:TowerofHanoi-v0-random",
    "gem.envs.game_env.tower_of_hanoi:TowerofHanoiEnv",
    num_disks=None,
    max_turns=None,
)
# Game2048
register(
    "game:Game2048-v0-easy",
    "gem.envs.game_env.game_2048:Game2048Env",
    target_tile=64,
    max_turns=50,
)
register(
    "game:Game2048-v0-hard",
    "gem.envs.game_env.game_2048:Game2048Env",
    target_tile=512,
    max_turns=50,
)
register(
    "game:Game2048-v0-extreme-hard",
    "gem.envs.game_env.game_2048:Game2048Env",
    target_tile=2048,
    max_turns=100,
)
register(
    "game:Game2048-v0-random",
    "gem.envs.game_env.game_2048:Game2048Env",
    target_tile=None,
    max_turns=None,
)
# Sokoban
register(
    "game:Sokoban-v0-easy",
    "gem.envs.game_env.sokoban:SokobanEnv",
    dim_room=(6, 6),
    num_boxes=2,
    max_turns=20,
)
register(
    "game:Sokoban-v0-hard",
    "gem.envs.game_env.sokoban:SokobanEnv",
    dim_room=(8, 8),
    num_boxes=4,
    max_turns=50,
)
register(
    "game:Sokoban-v0-random",
    "gem.envs.game_env.sokoban:SokobanEnv",
    room_size=None,
    num_boxes=None,
    max_turns=None,
)
# crosswords
register(
    "game:Crosswords-v0-easy",
    "gem.envs.game_env.crosswords:CrosswordsEnv",
    hardcore=False,
    max_turns=30,
    num_words=3,
)
register(
    "game:Crosswords-v0-hard",
    "gem.envs.game_env.crosswords:CrosswordsEnv",
    hardcore=True,
    max_turns=40,
    num_words=3,
)
register(
    "game:Crosswords-v0-random",
    "gem.envs.game_env.crosswords:CrosswordsEnv",
    hardcore=None,
    max_turns=None,
    num_words=None,
)
# wordsearch
register(
    "game:WordSearch-v0-easy",
    "gem.envs.game_env.word_search:WordSearchEnv",
    num_words=5,
    max_turns=20,
    hardcore=False,
)
register(
    "game:WordSearch-v0-hard",
    "gem.envs.game_env.word_search:WordSearchEnv",
    num_words=5,
    max_turns=20,
    hardcore=True,
)
register(
    "game:WordSearch-v0-random",
    "gem.envs.game_env.word_search:WordSearchEnv",
    num_words=None,
    max_turns=None,
    hardcore=None,
)

# Register math dataset environments

register(
    "math:ASDiv2K",
    "gem.envs.math_env:MathEnv",
    dataset_name="axon-rl/ASDIV-2k",
    question_key="problem",
    answer_key="answer",
)

register(
    "math:GSM8K",
    "gem.envs.math_env:MathEnv",
    dataset_name="axon-rl/GSM-8k",
    question_key="problem",
    answer_key="answer",
)

register(
    "math:Math12K",
    "gem.envs.math_env:MathEnv",
    dataset_name="axon-rl/MATH-12k",
    question_key="problem",
    answer_key="answer",
)

register(
    "math:Math8K-3to5",
    "gem.envs.math_env:MathEnv",
    dataset_name="axon-rl/MATH-lvl3to5-8k",
    question_key="problem",
    answer_key="answer",
)

register(
    "math:Orz57K",
    "gem.envs.math_env:MathEnv",
    dataset_name="axon-rl/ORZ-57k",
    question_key="problem",
    answer_key="answer",
)

register(
    "math:DeepScaleR40K",
    "gem.envs.math_env:MathEnv",
    dataset_name="axon-rl/DeepScaleR-40K",
    question_key="problem",
    answer_key="answer",
)

register(
    "math:Geometry3K",
    "gem.envs.math_visual_env:MathVisualEnv",
    dataset_name="axon-rl/geometry3k",
    split="train",
    image_key="images",
    question_key="problem",
    answer_key="answer",
)


# Register code dataset environments

register(
    "code:CodeContest",
    "gem.envs.code_env:CodeEnv",
    dataset_name="axon-rl/CodeContest",
    split="train",
    question_key="problem",
    test_key="tests",
)

register(
    "code:Taco8k",
    "gem.envs.code_env:CodeEnv",
    dataset_name="axon-rl/TACO-8k",
    split="train",
    question_key="problem",
    test_key="tests",
)

register(
    "code:PrimeIntellect15k",
    "gem.envs.code_env:CodeEnv",
    dataset_name="axon-rl/PrimeIntellect-15k",
    split="train",
    question_key="problem",
    test_key="tests",
)

# Register qa dataset environments

for i in [0, 1, 2, 3, 5]:
    register(
        f"logic:RuleTaker-d{i}",
        "gem.envs.qa_env:QaEnv",
        dataset_name=f"axon-rl/RuleTaker-d{i}-70k",
        split="train",
        extract_boxed=True,
        question_key="question",
        answer_key="answer",
    )

register(
    "qa:NaturalQuestions",
    "gem.envs.qa_env:QaEnv",
    dataset_name="axon-rl/NaturalQuestions",
    split="train",
    question_key="problem",
    answer_key="answer",
)

register(
    "qa:HotpotQA",
    "gem.envs.qa_env:QaEnv",
    dataset_name="axon-rl/HotpotQA",
    split="train",
    question_key="problem",
    answer_key="answer",
)

# Register datasets from ReasoningGym

