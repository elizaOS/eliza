/**
 * Interactive Data Table Example
 *
 * Creates a sortable, filterable data table that links with charts.
 * Features:
 * - Two-way highlighting (click table row -> highlight chart element)
 * - Formatted numbers
 * - Click to sort columns
 */

function createInteractiveTable(data) {
    const container = d3.select('#table-container');

    // Create table structure
    const table = container.append('table')
        .attr('id', 'data-table');

    // Define columns
    const columns = [
        {key: 'ticker', label: 'Ticker', format: d => d},
        {key: 'name', label: 'Company Name', format: d => d},
        {key: 'sector', label: 'Sector', format: d => d},
        {key: 'marketCap', label: 'Market Cap', format: formatNumber}
    ];

    // Create header
    const thead = table.append('thead');
    const headerRow = thead.append('tr');

    headerRow.selectAll('th')
        .data(columns)
        .join('th')
        .text(d => d.label)
        .on('click', function(event, col) {
            sortTable(data, col.key);
        })
        .style('cursor', 'pointer');

    // Create body
    const tbody = table.append('tbody');

    function renderTable(data) {
        const rows = tbody.selectAll('tr')
            .data(data, d => d.ticker)  // Key function for stable updates
            .join('tr')
            .on('click', function(event, d) {
                selectRow(d.ticker);
            });

        rows.selectAll('td')
            .data(d => columns.map(col => ({
                value: d[col.key],
                format: col.format
            })))
            .join('td')
            .text(d => d.format(d.value));
    }

    renderTable(data);

    // Sorting function
    let sortAscending = true;
    let sortKey = null;

    function sortTable(data, key) {
        if (sortKey === key) {
            sortAscending = !sortAscending;
        } else {
            sortKey = key;
            sortAscending = true;
        }

        data.sort((a, b) => {
            const aVal = a[key];
            const bVal = b[key];

            if (typeof aVal === 'string') {
                return sortAscending ?
                    aVal.localeCompare(bVal) :
                    bVal.localeCompare(aVal);
            } else {
                return sortAscending ?
                    (aVal || 0) - (bVal || 0) :
                    (bVal || 0) - (aVal || 0);
            }
        });

        renderTable(data);
    }

    // Return table API
    return {
        update: renderTable,
        sort: sortTable
    };
}

function selectRow(ticker) {
    // Highlight row
    d3.selectAll('#data-table tbody tr')
        .classed('selected', function(d) {
            return d && d.ticker === ticker;
        });

    // Trigger chart highlight if exists
    if (typeof highlightBubble === 'function') {
        highlightBubble(ticker);
    }
}

function highlightTableRow(ticker) {
    d3.selectAll('#data-table tbody tr')
        .classed('highlighted', function(d) {
            return d && d.ticker === ticker;
        });
}

// Number formatting utility
function formatNumber(num) {
    if (num === null || num === undefined || num === '') return '-';

    const absNum = Math.abs(num);
    let formatted;

    if (absNum >= 1e12) {
        formatted = (num / 1e12).toFixed(2) + 'T';
    } else if (absNum >= 1e9) {
        formatted = (num / 1e9).toFixed(2) + 'B';
    } else if (absNum >= 1e6) {
        formatted = (num / 1e6).toFixed(2) + 'M';
    } else if (absNum >= 1e3) {
        formatted = (num / 1e3).toFixed(2) + 'K';
    } else {
        formatted = num.toFixed(2);
    }

    return num < 0 ? '-' + formatted : formatted;
}

// CSS for table styling
const tableStyles = `
<style>
table {
    width: 100%;
    border-collapse: collapse;
    margin: 20px 0;
}

th {
    background: #f5f5f5;
    padding: 10px;
    text-align: left;
    border-bottom: 2px solid #ddd;
    font-weight: bold;
}

th:hover {
    background: #e0e0e0;
}

td {
    padding: 8px 10px;
    border-bottom: 1px solid #eee;
}

tr:hover {
    background: #f9f9f9;
}

tr.selected {
    background: #e3f2fd !important;
    border-left: 3px solid #2196f3;
}

tr.highlighted {
    background: #fff9c4 !important;
}
</style>
`;

// Inject styles
if (typeof document !== 'undefined') {
    const styleEl = document.createElement('div');
    styleEl.innerHTML = tableStyles;
    document.head.appendChild(styleEl.firstChild);
}
