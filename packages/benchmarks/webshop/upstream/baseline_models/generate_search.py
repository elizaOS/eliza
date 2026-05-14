import json
import time

import torch
from tqdm import tqdm
from transformers import BartForConditionalGeneration

from train_search import get_data, get_dataset, tokenizer

if __name__ == "__main__":
    model = BartForConditionalGeneration.from_pretrained(
        './ckpts/web_search/checkpoint-800')
    model.eval()
    model = model.to('cuda')
    dataset = get_dataset("web_search")
    dataloader = torch.utils.data.DataLoader(dataset["all"], batch_size=32)
    _, all_goals = get_data("all")
    all_dec = []
    for batch in tqdm(dataloader):
        output = model.generate(
            input_ids=batch["input_ids"].to('cuda'),
            attention_mask=batch["attention_mask"].to('cuda'),
            num_beams=10, num_return_sequences=10,
            max_length=512, early_stopping=True
        )
        dec = tokenizer.batch_decode(
            output, skip_special_tokens=True, clean_up_tokenization_spaces=False)
        assert len(dec) % 10 == 0
        for i in range(len(dec) // 10):
            all_dec.append(dec[i*10:(i+1)*10])
    assert len(all_goals) == len(all_dec)
    d = {goal: dec for goal, dec in zip(all_goals, all_dec)}
    with open('./data/goal_query_predict.json', 'w') as f:
        json.dump(d, f)
