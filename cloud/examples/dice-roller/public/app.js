document.addEventListener('DOMContentLoaded', () => {
  const rollBtn = document.getElementById('rollBtn');
  const resultEl = document.getElementById('result');
  rollBtn.addEventListener('click', () => {
    const roll = Math.floor(Math.random() * 6) + 1; // 1-6
    resultEl.textContent = `You rolled: ${roll}`;
  });
});
