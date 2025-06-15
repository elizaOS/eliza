describe('Chat Functionality', () => {
  beforeEach(() => {
    // Mock WebSocket connection
    cy.visit('/');
    cy.waitForApp();
    
    // Navigate to a chat
    cy.get('[data-testid="agent-card"]').first().click();
    cy.contains('Chat').click();
  });

  it('displays chat interface', () => {
    // Check for chat components
    cy.get('[data-testid="chat-container"]').should('exist');
    cy.get('[data-testid="chat-messages"]').should('exist');
    cy.get('[data-testid="chat-input"]').should('exist');
  });

  it('can send a message', () => {
    const testMessage = 'Hello, this is a test message!';
    
    // Type message
    cy.get('[data-testid="chat-input"]').type(testMessage);
    
    // Send message
    cy.get('[data-testid="send-button"]').click();
    
    // Message should appear in chat
    cy.get('[data-testid="chat-messages"]')
      .should('contain.text', testMessage);
    
    // Input should be cleared
    cy.get('[data-testid="chat-input"]').should('have.value', '');
  });

  it('supports keyboard shortcuts', () => {
    const testMessage = 'Test message with Enter key';
    
    // Type and send with Enter
    cy.get('[data-testid="chat-input"]')
      .type(testMessage)
      .type('{enter}');
    
    // Message should appear
    cy.get('[data-testid="chat-messages"]')
      .should('contain.text', testMessage);
  });

  it('shows typing indicator', () => {
    // Mock incoming typing event
    cy.window().then((win) => {
      // Emit typing event through socket if available
      if ((win as any).socket) {
        (win as any).socket.emit('typing', { isTyping: true });
      }
    });
    
    // Should show typing indicator
    cy.get('[data-testid="typing-indicator"]').should('be.visible');
  });

  it('displays message timestamps', () => {
    // Send a message
    cy.get('[data-testid="chat-input"]').type('Test message');
    cy.get('[data-testid="send-button"]').click();
    
    // Check for timestamp
    cy.get('[data-testid="message-timestamp"]').should('exist');
  });

  it('handles long messages', () => {
    const longMessage = 'Lorem ipsum '.repeat(50);
    
    // Send long message
    cy.get('[data-testid="chat-input"]').type(longMessage, { delay: 0 });
    cy.get('[data-testid="send-button"]').click();
    
    // Message should be displayed properly
    cy.get('[data-testid="chat-messages"]')
      .should('contain.text', 'Lorem ipsum');
  });

  it('supports message editing', () => {
    // Send a message first
    cy.get('[data-testid="chat-input"]').type('Original message');
    cy.get('[data-testid="send-button"]').click();
    
    // Right-click on message for context menu
    cy.get('[data-testid="chat-message"]').last().rightclick();
    
    // Click edit option
    cy.contains('Edit').click();
    
    // Edit the message
    cy.get('[data-testid="edit-input"]')
      .clear()
      .type('Edited message');
    
    // Save edit
    cy.get('[data-testid="save-edit-button"]').click();
    
    // Message should be updated
    cy.get('[data-testid="chat-message"]').last()
      .should('contain.text', 'Edited message');
  });

  it('supports message deletion', () => {
    // Send a message
    cy.get('[data-testid="chat-input"]').type('Message to delete');
    cy.get('[data-testid="send-button"]').click();
    
    // Right-click on message
    cy.get('[data-testid="chat-message"]').last().rightclick();
    
    // Click delete option
    cy.contains('Delete').click();
    
    // Confirm deletion
    cy.get('[data-testid="confirm-delete"]').click();
    
    // Message should be removed
    cy.get('[data-testid="chat-messages"]')
      .should('not.contain.text', 'Message to delete');
  });

  it('loads message history', () => {
    // Scroll to top to trigger history loading
    cy.get('[data-testid="chat-messages"]').scrollTo('top');
    
    // Should show loading indicator
    cy.get('[data-testid="loading-history"]').should('exist');
    
    // Mock history response
    cy.intercept('GET', '/api/messages/*', {
      body: {
        messages: [
          { id: 1, text: 'Historical message 1' },
          { id: 2, text: 'Historical message 2' }
        ]
      }
    }).as('loadHistory');
    
    // Wait for history to load
    cy.wait('@loadHistory');
    
    // Should display historical messages
    cy.get('[data-testid="chat-messages"]')
      .should('contain.text', 'Historical message 1')
      .should('contain.text', 'Historical message 2');
  });

  it('handles file uploads', () => {
    // Click file upload button
    cy.get('[data-testid="file-upload-button"]').click();
    
    // Select a file
    cy.get('input[type="file"]').selectFile({
      contents: Cypress.Buffer.from('file contents'),
      fileName: 'test.txt',
      mimeType: 'text/plain',
      lastModified: Date.now()
    });
    
    // Should show file preview
    cy.get('[data-testid="file-preview"]')
      .should('exist')
      .should('contain.text', 'test.txt');
    
    // Send message with file
    cy.get('[data-testid="send-button"]').click();
    
    // Should show file attachment in message
    cy.get('[data-testid="message-attachment"]')
      .should('exist')
      .should('contain.text', 'test.txt');
  });

  it('supports emoji picker', () => {
    // Click emoji button
    cy.get('[data-testid="emoji-button"]').click();
    
    // Emoji picker should appear
    cy.get('[data-testid="emoji-picker"]').should('be.visible');
    
    // Select an emoji
    cy.get('[data-testid="emoji-picker"]')
      .contains('😀')
      .click();
    
    // Emoji should be added to input
    cy.get('[data-testid="chat-input"]')
      .should('have.value', '😀');
    
    // Close emoji picker
    cy.get('body').click(0, 0);
    cy.get('[data-testid="emoji-picker"]').should('not.exist');
  });

  it('handles connection errors', () => {
    // Simulate connection error
    cy.window().then((win) => {
      if ((win as any).socket) {
        (win as any).socket.disconnect();
      }
    });
    
    // Should show connection error
    cy.get('[data-testid="connection-error"]').should('be.visible');
    
    // Try to send message
    cy.get('[data-testid="chat-input"]').type('Test message');
    cy.get('[data-testid="send-button"]').click();
    
    // Should show error notification
    cy.contains('Failed to send message').should('be.visible');
  });

  it('supports message reactions', () => {
    // Send a message
    cy.get('[data-testid="chat-input"]').type('React to this message');
    cy.get('[data-testid="send-button"]').click();
    
    // Hover over message to show reaction button
    cy.get('[data-testid="chat-message"]').last().trigger('mouseenter');
    
    // Click reaction button
    cy.get('[data-testid="reaction-button"]').click();
    
    // Select a reaction
    cy.get('[data-testid="reaction-picker"]')
      .contains('👍')
      .click();
    
    // Reaction should be displayed
    cy.get('[data-testid="message-reactions"]')
      .should('exist')
      .should('contain.text', '👍');
  });

  it('supports audio messages', () => {
    // Click audio button
    cy.get('[data-testid="audio-button"]').click();
    
    // Should show recording UI
    cy.get('[data-testid="recording-indicator"]').should('be.visible');
    
    // Stop recording after a moment
    cy.wait(2000);
    cy.get('[data-testid="stop-recording-button"]').click();
    
    // Should show audio preview
    cy.get('[data-testid="audio-preview"]').should('exist');
    
    // Send audio message
    cy.get('[data-testid="send-audio-button"]').click();
    
    // Should show audio message in chat
    cy.get('[data-testid="audio-message"]').should('exist');
  });
}); 