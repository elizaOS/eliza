import time

from .file_utils import *
from .json_utils import *


class EventRecorder:
    def __init__(
        self,
        ckpt_dir="ckpt",
        resume=False,
        init_position=None,
    ):
        self.ckpt_dir = ckpt_dir
        self.item_history = set()
        self.item_vs_time = {}
        self.item_vs_iter = {}
        self.biome_history = set()
        self.init_position = init_position
        self.position_history = [[0, 0]]
        self.elapsed_time = 0
        self.iteration = 0
        f_mkdir(self.ckpt_dir, "events")
        if resume:
            self.resume()

    def record(self, events, task):
        task = re.sub(r'[\\/:"*?<>| ]', "_", task)
        task = task.replace(" ", "_") + time.strftime(
            "_%Y%m%d_%H%M%S", time.localtime()
        )
        self.iteration += 1
        # if not self.init_position:
        #     self.init_position = [
        #         events[0][1]["status"]["position"]["x"],
        #         events[0][1]["status"]["position"]["z"],
        #     ]
        # for event_type, event in events:
            # self.update_items(event)
            # if event_type == "observe":
            #     self.update_elapsed_time(event)
        logging.info(
            f"\033[96m****Recorder message: {self.elapsed_time} ticks have elapsed****\033[0m\n"
            f"\033[96m****Recorder message: {self.iteration} iteration passed****\033[0m"
        )
        dump_json(events, f_join(self.ckpt_dir, "events", task))

    def resume(self, cutoff=None):
        self.item_history = set()
        self.item_vs_time = {}
        self.item_vs_iter = {}
        self.elapsed_time = 0
        self.position_history = [[0, 0]]

        def get_timestamp(string):
            timestamp = "_".join(string.split("_")[-2:])
            return time.mktime(time.strptime(timestamp, "%Y%m%d_%H%M%S"))

        records = f_listdir(self.ckpt_dir, "events")
        sorted_records = sorted(records, key=get_timestamp)
        for record in sorted_records:
            self.iteration += 1
            if cutoff and self.iteration > cutoff:
                break
            events = load_json(f_join(self.ckpt_dir, "events", record))
            if not self.init_position:
                self.init_position = (
                    events[0][1]["status"]["position"]["x"],
                    events[0][1]["status"]["position"]["z"],
                )
            for event_type, event in events:
                # self.update_items(event)
                self.update_position(event)
                if event_type == "observe":
                    self.update_elapsed_time(event)

    def update_items(self, event):
        pass
        # inventory = event["inventory"]
        # elapsed_time = event["status"]["elapsedTime"]
        # biome = event["status"]["biome"]
        # items = set(inventory.keys())
        # new_items = items - self.item_history
        # self.item_history.update(items)
        # self.biome_history.add(biome)
        # if new_items:
        #     if self.elapsed_time + elapsed_time not in self.item_vs_time:
        #         self.item_vs_time[self.elapsed_time + elapsed_time] = []
        #     self.item_vs_time[self.elapsed_time + elapsed_time].extend(new_items)
        #     if self.iteration not in self.item_vs_iter:
        #         self.item_vs_iter[self.iteration] = []
        #     self.item_vs_iter[self.iteration].extend(new_items)

    # def update_elapsed_time(self, event):
        # self.elapsed_time += event["status"]["elapsedTime"]

    def update_position(self, event):
        position = [
            event["status"]["position"]["x"] - self.init_position[0],
            event["status"]["position"]["z"] - self.init_position[1],
        ]
        if self.position_history[-1] != position:
            self.position_history.append(position)