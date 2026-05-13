/**
 * Complete Bubble Chart Example with Force Simulation
 *
 * This example shows how to create a clustered bubble chart with:
 * - Force-directed layout
 * - Collision detection
 * - Color coding by category
 * - Size scaling by value
 */

// Configuration
const width = 800;
const height = 600;
const margin = {top: 20, right: 20, bottom: 20, left: 20};

// Create SVG
const svg = d3.select('#chart')
    .append('svg')
    .attr('width', width)
    .attr('height', height);

// Load and process data
d3.csv('/data/stocks.csv').then(data => {
    // Parse numbers
    data.forEach(d => {
        d.value = d.marketCap ? +d.marketCap : null;
        d.ticker = d.ticker;
        d.sector = d.sector;
    });

    createBubbleChart(data);
});

function createBubbleChart(data) {
    // Setup scales
    const radiusScale = d3.scaleSqrt()
        .domain([0, d3.max(data, d => d.value || 0)])
        .range([5, 50]);

    const colorScale = d3.scaleOrdinal()
        .domain([...new Set(data.map(d => d.sector))])
        .range(d3.schemeCategory10);

    // Calculate radius for each data point
    data.forEach(d => {
        if (d.value === null || isNaN(d.value)) {
            d.radius = 10; // Uniform size for missing data
            d.hasValue = false;
        } else {
            d.radius = radiusScale(d.value);
            d.hasValue = true;
        }
    });

    // Create force simulation
    const simulation = d3.forceSimulation(data)
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collide', d3.forceCollide(d => d.radius + 2))
        .force('charge', d3.forceManyBody().strength(-30));

    // Optional: Cluster by sector
    const sectors = [...new Set(data.map(d => d.sector))];
    const sectorPositions = {};
    sectors.forEach((sector, i) => {
        const angle = (i / sectors.length) * 2 * Math.PI;
        sectorPositions[sector] = {
            x: width / 2 + Math.cos(angle) * 150,
            y: height / 2 + Math.sin(angle) * 150
        };
    });

    simulation
        .force('x', d3.forceX(d => sectorPositions[d.sector].x).strength(0.5))
        .force('y', d3.forceY(d => sectorPositions[d.sector].y).strength(0.5));

    // Create bubbles
    const bubbles = svg.selectAll('circle')
        .data(data)
        .join('circle')
        .attr('class', 'bubble')
        .attr('r', d => d.radius)
        .attr('fill', d => colorScale(d.sector))
        .attr('opacity', 0.7)
        .on('mouseover', function(event, d) {
            // Only show tooltip if has complete data
            if (d.sector !== 'ETF') {
                showTooltip(event, d);
            }
        })
        .on('mouseout', hideTooltip)
        .on('click', function(event, d) {
            selectBubble(d.ticker);
        });

    // Update positions on each tick
    simulation.on('tick', () => {
        bubbles
            .attr('cx', d => d.x)
            .attr('cy', d => d.y);
    });
}

function showTooltip(event, d) {
    const tooltip = d3.select('#tooltip');
    tooltip
        .classed('visible', true)
        .html(`
            <strong>${d.ticker}</strong><br/>
            ${d.name || 'N/A'}<br/>
            Sector: ${d.sector}
        `)
        .style('left', (event.pageX + 10) + 'px')
        .style('top', (event.pageY - 10) + 'px');
}

function hideTooltip() {
    d3.select('#tooltip').classed('visible', false);
}

function selectBubble(ticker) {
    // Highlight selected bubble
    d3.selectAll('.bubble')
        .classed('selected', d => d.ticker === ticker);

    // Trigger table highlight if exists
    if (typeof highlightTableRow === 'function') {
        highlightTableRow(ticker);
    }
}
