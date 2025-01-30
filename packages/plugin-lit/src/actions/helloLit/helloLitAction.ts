const _litActionCode = async () => {
  console.log(magicNumber);
  try {
    LitActions.setResponse({ response: JSON.stringify({ message: "Hello from Lit Protocol!" }) });
  } catch (error) {
    LitActions.setResponse({ response: error.message });
  }
};

export const litActionCode = `(${_litActionCode.toString()})();`;
