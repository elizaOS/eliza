"""
Model implementations. The model interface should be suitable for both
the ``site env'' and the ``text env''.
"""
import random

random.seed(4)


class BasePolicy:
    def __init__(self):
        pass
    
    def forward(observation, available_actions):
        """
        Args:
            observation (`str`):
                HTML string

            available_actions ():
                ...
        Returns:
            action (`str`): 
                Return string of the format ``action_name[action_arg]''.
                Examples:
                    - search[white shoes]
                    - click[button=Reviews]
                    - click[button=Buy Now]
        """
        raise NotImplementedError


class HumanPolicy(BasePolicy):
    def __init__(self):
        super().__init__()

    def forward(self, observation, available_actions):
        action = input('> ')
        return action


class RandomPolicy(BasePolicy):
    def __init__(self):
        super().__init__()
    
    def forward(self, observation, available_actions):
        if available_actions['has_search_bar']:
            action = 'search[shoes]'
        else:
            action_arg = random.choice(available_actions['clickables'])
            action = f'click[{action_arg}]'
        return action
