/**
 * Reusable Tooltip Handler for D3.js Visualizations
 *
 * Provides a flexible tooltip system with:
 * - Conditional display based on data properties
 * - Customizable content templates
 * - Automatic positioning
 * - CSS class-based visibility
 */

class TooltipHandler {
    constructor(options = {}) {
        this.selector = options.selector || '#tooltip';
        this.offsetX = options.offsetX || 10;
        this.offsetY = options.offsetY || -10;
        this.shouldShow = options.shouldShow || (() => true);
        this.formatContent = options.formatContent || this.defaultFormat;

        this.tooltip = d3.select(this.selector);

        // Create tooltip if it doesn't exist
        if (this.tooltip.empty()) {
            this.tooltip = d3.select('body')
                .append('div')
                .attr('id', this.selector.replace('#', ''))
                .attr('class', 'tooltip');
        }
    }

    /**
     * Show tooltip for a data point
     * @param {Event} event - Mouse event
     * @param {Object} data - Data point
     */
    show(event, data) {
        // Check if tooltip should be shown for this data
        if (!this.shouldShow(data)) {
            return;
        }

        const content = this.formatContent(data);

        this.tooltip
            .classed('visible', true)
            .html(content)
            .style('left', (event.pageX + this.offsetX) + 'px')
            .style('top', (event.pageY + this.offsetY) + 'px');
    }

    /**
     * Hide tooltip
     */
    hide() {
        this.tooltip.classed('visible', false);
    }

    /**
     * Move tooltip to follow mouse
     * @param {Event} event - Mouse event
     */
    move(event) {
        if (this.tooltip.classed('visible')) {
            this.tooltip
                .style('left', (event.pageX + this.offsetX) + 'px')
                .style('top', (event.pageY + this.offsetY) + 'px');
        }
    }

    /**
     * Default content formatter
     * @param {Object} data - Data point
     * @returns {string} HTML content
     */
    defaultFormat(data) {
        return `
            <strong>${data.name || data.id}</strong><br/>
            ${data.value ? 'Value: ' + data.value : ''}
        `;
    }

    /**
     * Attach tooltip handlers to D3 selection
     * @param {d3.Selection} selection - D3 selection
     */
    attach(selection) {
        const self = this;

        selection
            .on('mouseover', function(event, d) {
                self.show(event, d);
            })
            .on('mousemove', function(event) {
                self.move(event);
            })
            .on('mouseout', function() {
                self.hide();
            });

        return selection;
    }
}

// Example usage patterns

/**
 * Example 1: Basic tooltip
 */
function example1() {
    const tooltip = new TooltipHandler();

    d3.selectAll('circle')
        .on('mouseover', (event, d) => tooltip.show(event, d))
        .on('mouseout', () => tooltip.hide());
}

/**
 * Example 2: Conditional tooltip (exclude specific categories)
 */
function example2() {
    const tooltip = new TooltipHandler({
        shouldShow: (d) => d.category !== 'ETF',  // Don't show for ETFs
        formatContent: (d) => `
            <strong>${d.ticker}</strong><br/>
            ${d.name}<br/>
            Sector: ${d.sector}
        `
    });

    tooltip.attach(d3.selectAll('circle'));
}

/**
 * Example 3: Rich formatted tooltip
 */
function example3() {
    const tooltip = new TooltipHandler({
        shouldShow: (d) => d.hasCompleteData,
        formatContent: (d) => {
            const parts = [
                `<div class="tooltip-header">${d.name}</div>`,
                `<div class="tooltip-body">`,
                `  <div>Ticker: ${d.ticker}</div>`,
                `  <div>Sector: ${d.sector}</div>`,
            ];

            if (d.marketCap) {
                parts.push(`  <div>Market Cap: ${formatNumber(d.marketCap)}</div>`);
            }

            parts.push(`</div>`);
            return parts.join('');
        }
    });

    tooltip.attach(d3.selectAll('.bubble'));
}

/**
 * Example 4: Multiple tooltips with different styles
 */
function example4() {
    // Tooltip for bubbles
    const bubbleTooltip = new TooltipHandler({
        selector: '#bubble-tooltip',
        shouldShow: (d) => d.type !== 'excluded'
    });

    // Tooltip for table cells
    const tableTooltip = new TooltipHandler({
        selector: '#table-tooltip',
        formatContent: (d) => `Details: ${d.description}`
    });

    bubbleTooltip.attach(d3.selectAll('.bubble'));
    tableTooltip.attach(d3.selectAll('.info-cell'));
}

// Helper function for number formatting
function formatNumber(num) {
    if (!num) return '-';
    if (num >= 1e12) return (num / 1e12).toFixed(2) + 'T';
    if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
    return num.toFixed(2);
}

// Required CSS (add to your stylesheet)
const requiredCSS = `
.tooltip {
    position: absolute;
    padding: 10px;
    background: rgba(0, 0, 0, 0.8);
    color: white;
    border-radius: 4px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.2s;
    z-index: 1000;
    font-size: 14px;
    line-height: 1.4;
}

.tooltip.visible {
    opacity: 1;
}

.tooltip-header {
    font-weight: bold;
    margin-bottom: 5px;
    border-bottom: 1px solid rgba(255,255,255,0.3);
    padding-bottom: 3px;
}

.tooltip-body {
    font-size: 12px;
}

.tooltip-body div {
    margin: 2px 0;
}
`;

// Export for use in modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TooltipHandler;
}
