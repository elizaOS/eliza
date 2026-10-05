import gymnasium as gym

env = gym.make("CartPole-v1")


num_episodes = 100
for episode in range(num_episodes):
    current_observation, info = env.reset()
    total_reward = 0

    while True:
        ## here would be the place to add your agent's action selection logic
        action = env.action_space.sample()

        next_observation, reward, terminated, truncated, info = env.step(action)

        total_reward += reward
        current_observation = next_observation

        if terminated or truncated:
            break

    print(
        f"Episode {episode + 1}/{num_episodes}, Total Reward: {total_reward}", end="\r"
    )

env.close()
