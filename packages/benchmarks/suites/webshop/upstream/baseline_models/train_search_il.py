import json
import os
import random

from datasets import Dataset, DatasetDict, load_from_disk
from transformers import (BartForConditionalGeneration, BartTokenizer, Trainer,
                          TrainingArguments)
from transformers.models.bart.modeling_bart import shift_tokens_right

tokenizer = BartTokenizer.from_pretrained('facebook/bart-large')
BOS_TOKEN_ID = 0
PAD_TOKEN_ID = 1
EOS_TOKEN_ID = 2
UNK_TOKEN_ID = 3

PATH = "./data/goal_query_map.json"
HUMAN_GOAL_PATH = './data/human_goals.json'
GOAL_PATH = "./data/items_human_ins.json"


def process_str(s):
    s = s.lower().replace('"', '').replace("'", "").strip()
    return s


def process_goal(state):
    state = state.lower().replace('"', '').replace("'", "")
    state = state.replace('amazon shopping game\ninstruction:', '').replace('webshop\ninstruction:', '')
    state = state.replace('\n[button] search [button_]', '').strip()
    if ', and price lower than' in state:
        state = state.split(', and price lower than')[0]
    return state

def get_data(split):
    data = json.load(open(PATH))
    goals, searches = [], []
    for goal, search_list in data.items():
        goal = process_goal(goal)
        for search in search_list:
            search = process_str(search)
            goals.append(goal)
            searches.append(search)
    n = len(goals)

    human_goals = json.load(open(HUMAN_GOAL_PATH, 'r'))
    goal_range = range(len(human_goals))
    if split == 'train':
        goal_range = range(500, len(human_goals))
    elif split == 'validation':
        goal_range = range(500, 1500)
    elif split == 'test':
        goal_range = range(0, 500)
    elif split == "all":  # all human instructions, but without groundtruth search queries
        all_data = json.load(open(GOAL_PATH))
        all_goals = []
        all_goals_processed = []
        for ins_list in all_data.values():
            for ins in ins_list:
                ins = ins['instruction']
                all_goals.append(ins)
                all_goals_processed.append(process_str(ins))
        return all_goals_processed, all_goals
    
    goals_, searches_ = [], []
    for goal, search in zip(goals, searches):
        if goal in human_goals and human_goals.index(goal) in goal_range:
            goals_.append(goal)
            searches_.append(search)
    return goals_, searches_


def get_dataset(name, flip=False, variant=None, size=None):
    fname = name + "-flip" if flip else name
    fpath = os.path.join(os.path.dirname(__file__), fname)
    d = {}
    splits = ["train", "validation", "test"]
    if name == "web_search":
        splits = ["train", "validation", "test", "all"]
    for split in splits:
        input, output = get_data(split) if name != "nl2bash" else get_data(
            split, variant=variant)
        l = len(input) if size is None else int(len(input) * size)
        print("{} size: {}".format(split, l))
        if flip:
            input, output = output, input
        input, output = input[:l], output[:l]
        d[split] = process_dataset(input, output)
    d = DatasetDict(d)
    return d


def process_dataset(input, output, max_len=256):
    input_encodings = tokenizer(input, padding='max_length',
                                max_length=max_len, truncation=True, return_tensors='pt')
    output_encodings = tokenizer(
        output, padding='max_length', max_length=max_len, truncation=True, return_tensors='pt')
    labels = output_encodings['input_ids']
    decoder_input_ids = shift_tokens_right(labels, PAD_TOKEN_ID, EOS_TOKEN_ID)
    labels[labels[:, :] == PAD_TOKEN_ID] = -100
    dataset = Dataset.from_dict({
        'input_ids': input_encodings['input_ids'],
        'attention_mask': input_encodings['attention_mask'],
        'decoder_input_ids': decoder_input_ids,
        'labels': labels,
    })
    dataset.set_format(type='torch', columns=[
                       'input_ids', 'labels', 'decoder_input_ids', 'attention_mask'])
    return dataset


if __name__ == "__main__":
    dataset = get_dataset("web_search", flip=False)
    train_dataset = dataset['train']
    print(train_dataset[0])
    model = BartForConditionalGeneration.from_pretrained('facebook/bart-base')
    model.resize_token_embeddings(len(tokenizer))
    # model = BartForConditionalGeneration.from_pretrained('./models/qdmr-high-level-base/checkpoint-10000')
    training_args = TrainingArguments(
        output_dir='./ckpts/web_search',
        num_train_epochs=10,
        per_device_train_batch_size=4,
        per_device_eval_batch_size=4,
        warmup_steps=50,
        weight_decay=0.01,
        evaluation_strategy="steps",
        logging_dir='./logs',
        logging_steps=50,
        eval_steps=20,
        save_steps=200
        # eval_accumulation_steps=1
    )
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=dataset["validation"],
        compute_metrics=None,
    )
    trainer.train()
