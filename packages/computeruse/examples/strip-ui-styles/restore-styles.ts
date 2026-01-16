/**
 * Browser script to restore original styles after stripping.
 * Only works if strip-styles.ts was run first.
 */

function restoreStyles(): { success: boolean; message: string } {
  const stored = (window as any).__originalStyles;

  if (!stored) {
    return {
      success: false,
      message: 'No original styles stored. Either strip-styles was not run, or page was refreshed.'
    };
  }

  // The only reliable way to fully restore is to reload the page
  // But we can at least remove our injected styles
  const baseStyles = document.getElementById('stripped-base-styles');
  if (baseStyles) {
    baseStyles.remove();
  }

  return {
    success: true,
    message: 'Base styles removed. For full restoration, please refresh the page (F5).'
  };
}

return restoreStyles();
