import React from 'react';
import '../../../frontend/index.css';

/**
 * Example accessible form component
 */
const AccessibleForm: React.FC<{ onSubmit: (data: any) => void }> = ({ onSubmit }) => {
  const [formData, setFormData] = React.useState({
    name: '',
    email: '',
    message: '',
  });
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const newErrors: Record<string, string> = {};

    if (!formData.name) newErrors.name = 'Name is required';
    if (!formData.email) newErrors.email = 'Email is required';
    if (formData.email && !formData.email.includes('@')) {
      newErrors.email = 'Please enter a valid email';
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    onSubmit(formData);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-4">
      <h1 className="text-2xl font-bold">Contact Agent</h1>

      <div>
        <label htmlFor="name" className="block text-sm font-medium mb-1">
          Name{' '}
          <span className="text-red-500" aria-label="required">
            *
          </span>
        </label>
        <input
          id="name"
          type="text"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          aria-invalid={!!errors.name}
          aria-describedby={errors.name ? 'name-error' : undefined}
          className="w-full px-3 py-2 border rounded-md"
        />
        {errors.name && (
          <p id="name-error" role="alert" className="text-red-500 text-sm mt-1">
            {errors.name}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="email" className="block text-sm font-medium mb-1">
          Email{' '}
          <span className="text-red-500" aria-label="required">
            *
          </span>
        </label>
        <input
          id="email"
          type="email"
          value={formData.email}
          onChange={(e) => setFormData({ ...formData, email: e.target.value })}
          aria-invalid={!!errors.email}
          aria-describedby={errors.email ? 'email-error' : undefined}
          className="w-full px-3 py-2 border rounded-md"
        />
        {errors.email && (
          <p id="email-error" role="alert" className="text-red-500 text-sm mt-1">
            {errors.email}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="message" className="block text-sm font-medium mb-1">
          Message
        </label>
        <textarea
          id="message"
          value={formData.message}
          onChange={(e) => setFormData({ ...formData, message: e.target.value })}
          rows={4}
          className="w-full px-3 py-2 border rounded-md"
        />
      </div>

      <button
        type="submit"
        className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        Send Message
      </button>
    </form>
  );
};

describe('Accessibility Tests', () => {
  describe('Form Accessibility', () => {
    it('should have proper labels for all form fields', () => {
      cy.mount(<AccessibleForm onSubmit={cy.stub()} />);

      // Check that labels are properly associated
      cy.get('label[for="name"]').should('exist');
      cy.get('label[for="email"]').should('exist');
      cy.get('label[for="message"]').should('exist');

      // Check that inputs have matching IDs
      cy.get('input#name').should('exist');
      cy.get('input#email').should('exist');
      cy.get('textarea#message').should('exist');
    });

    it('should indicate required fields', () => {
      cy.mount(<AccessibleForm onSubmit={cy.stub()} />);

      // Check for required field indicators
      cy.get('label[for="name"]').within(() => {
        cy.get('[aria-label="required"]').should('exist');
      });
      cy.get('label[for="email"]').within(() => {
        cy.get('[aria-label="required"]').should('exist');
      });
    });

    it('should show accessible error messages', () => {
      cy.mount(<AccessibleForm onSubmit={cy.stub()} />);

      // Submit empty form
      cy.get('button[type="submit"]').click();

      // Check error messages have proper ARIA attributes
      cy.get('#name-error').should('have.attr', 'role', 'alert');
      cy.get('#email-error').should('have.attr', 'role', 'alert');

      // Check inputs are marked as invalid
      cy.get('input#name').should('have.attr', 'aria-invalid', 'true');
      cy.get('input#email').should('have.attr', 'aria-invalid', 'true');

      // Check aria-describedby links errors to inputs
      cy.get('input#name').should('have.attr', 'aria-describedby', 'name-error');
      cy.get('input#email').should('have.attr', 'aria-describedby', 'email-error');
    });

    it('should be keyboard navigable', () => {
      cy.mount(<AccessibleForm onSubmit={cy.stub()} />);

      // Verify all form elements can receive focus
      cy.get('input#name').focus();
      cy.focused().should('have.attr', 'id', 'name');

      cy.get('input#email').focus();
      cy.focused().should('have.attr', 'id', 'email');

      cy.get('textarea#message').focus();
      cy.focused().should('have.attr', 'id', 'message');

      cy.get('button[type="submit"]').focus();
      cy.focused().should('contain', 'Send Message');

      // Verify tabindex is not preventing keyboard access
      cy.get('input, textarea, button').should('not.have.attr', 'tabindex', '-1');
    });

    it('should have proper focus indicators', () => {
      cy.mount(<AccessibleForm onSubmit={cy.stub()} />);

      // Check focus ring on button
      cy.get('button[type="submit"]').focus();
      cy.get('button[type="submit"]').should('have.class', 'focus:ring-2');
    });
  });

  describe('Color Contrast', () => {
    it('should maintain readable contrast in dark mode', () => {
      cy.mount(
        <div className="dark bg-gray-900 p-4">
          <h1 className="text-white">High Contrast Title</h1>
          <p className="text-gray-300">Body text with good contrast</p>
          <button className="bg-blue-600 text-white px-4 py-2">Action Button</button>
        </div>
      );

      // Visual check - in real tests you might use cypress-axe
      cy.get('h1').should('have.class', 'text-white');
      cy.get('p').should('have.class', 'text-gray-300');
    });
  });

  describe('Screen Reader Support', () => {
    it('should have proper heading hierarchy', () => {
      cy.mount(
        <article>
          <h1>Main Title</h1>
          <section>
            <h2>Section Title</h2>
            <p>Content</p>
            <h3>Subsection</h3>
            <p>More content</p>
          </section>
        </article>
      );

      // Check heading hierarchy
      cy.get('h1').should('have.length', 1);
      cy.get('h2').should('exist');
      cy.get('h3').should('exist');
    });

    it('should use semantic HTML elements', () => {
      cy.mount(
        <nav aria-label="Main navigation">
          <ul>
            <li>
              <a href="#home">Home</a>
            </li>
            <li>
              <a href="#about">About</a>
            </li>
          </ul>
        </nav>
      );

      cy.get('nav').should('have.attr', 'aria-label', 'Main navigation');
      cy.get('nav ul').should('exist');
      cy.get('nav a').should('have.length', 2);
    });
  });
});

/**
 * ACCESSIBILITY TESTING PATTERNS
 *
 * 1. ARIA ATTRIBUTES
 *    - Test aria-label, aria-describedby, aria-invalid
 *    - Verify role attributes for dynamic content
 *    - Check live regions for updates
 *
 * 2. KEYBOARD NAVIGATION
 *    - Test tab order
 *    - Verify all interactive elements are reachable
 *    - Check focus indicators
 *
 * 3. FORM ACCESSIBILITY
 *    - Labels properly associated with inputs
 *    - Error messages linked to fields
 *    - Required fields indicated
 *
 * 4. COLOR CONTRAST
 *    - Test in both light and dark modes
 *    - Ensure text is readable
 *    - Check focus indicators visibility
 *
 * 5. SCREEN READER SUPPORT
 *    - Proper heading hierarchy
 *    - Semantic HTML usage
 *    - Alternative text for images
 *
 * TOOLS TO CONSIDER:
 * - cypress-axe: Automated accessibility testing
 * - cypress-tab: Better keyboard navigation testing
 * - cypress-real-events: Test with real browser events
 */
