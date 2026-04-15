if ('scrollRestoration' in history) {
	history.scrollRestoration = 'manual';
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const state = {
	days: 21,
	hours: 72,
	room: '',
	isLoading: false,
	favorites: new Set(JSON.parse(localStorage.getItem('favRooms') || '[]')),
	latestCurrent: null
};

const elements = {
	statusPill: document.querySelector('#status-pill'),
	pollNowButton: document.querySelector('#poll-now-btn'),
	refreshButton: document.querySelector('#refresh-btn'),
	daysSelect: document.querySelector('#days-select'),
	hoursSelect: document.querySelector('#hours-select'),
	roomSelect: document.querySelector('#room-select'),
	lastUpdated: document.querySelector('#last-updated'),
	currentLoad: document.querySelector('#kpi-current-load'),
	currentCaption: document.querySelector('#kpi-current-caption'),
	freeMachines: document.querySelector('#kpi-free-machines'),
	freeCaption: document.querySelector('#kpi-free-caption'),
	bestSlot: document.querySelector('#kpi-best-slot'),
	bestCaption: document.querySelector('#kpi-best-caption'),
	averageLoad: document.querySelector('#kpi-average-load'),
	averageCaption: document.querySelector('#kpi-average-caption'),
	timelineSummary: document.querySelector('#timeline-summary'),
	timelineChart: document.querySelector('#timeline-chart'),
	bestTimesList: document.querySelector('#best-times-list'),
	heatmapGrid: document.querySelector('#heatmap-grid'),
	roomsTableBody: document.querySelector('#rooms-table-body'),
	failuresList: document.querySelector('#failures-list')
};

function clampRatio(value) {
	if (!Number.isFinite(value)) {
		return 0;
	}
	if (value < 0) {
		return 0;
	}
	if (value > 1) {
		return 1;
	}
	return value;
}

function formatPercent(value) {
	return `${Math.round(clampRatio(value) * 100)}%`;
}

function formatDateTime(isoString) {
	if (!isoString) {
		return 'Unknown';
	}

	const asDate = new Date(isoString);
	if (Number.isNaN(asDate.getTime())) {
		return isoString;
	}

	return asDate.toLocaleString([], {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	});
}

function formatHour(hour) {
	const suffix = hour >= 12 ? 'PM' : 'AM';
	const twelveHour = hour % 12 === 0 ? 12 : hour % 12;
	return `${twelveHour}:00 ${suffix}`;
}

function setStatus(className, text) {
	elements.statusPill.className = `status-pill ${className}`.trim();
	elements.statusPill.textContent = text;
}

function setLoading(loading) {
	state.isLoading = loading;
	elements.refreshButton.disabled = loading;
	elements.pollNowButton.disabled = loading;
	if (loading) {
		setStatus('warn', 'Refreshing data...');
	}
}

function getDashboardQuery() {
	const query = new URLSearchParams({
		days: String(state.days),
		hours: String(state.hours)
	});
	if (state.room) {
		query.set('room', state.room);
	}
	return query;
}

function ratioToHeatColor(ratio) {
	const normalized = clampRatio(ratio);
	const hue = 160 - normalized * 140;
	const saturation = 74;
	const lightness = 92 - normalized * 46;
	return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

function ratioToChipColor(ratio) {
	const normalized = clampRatio(ratio);
	const hue = 145 - normalized * 120;
	return `hsl(${hue} 64% 42%)`;
}

function syncRoomOptions(rooms) {
	const previousRoom = state.room;
	elements.roomSelect.innerHTML = '';

	const allOption = document.createElement('option');
	allOption.value = '';
	allOption.textContent = 'All rooms';
	elements.roomSelect.append(allOption);

	const sortedRooms = [...rooms].sort((a, b) => {
		const favA = state.favorites.has(a);
		const favB = state.favorites.has(b);
		return favA === favB ? a.localeCompare(b) : (favA ? -1 : 1);
	});

	for (const room of sortedRooms) {
		const option = document.createElement('option');
		option.value = room;
		option.textContent = room;
		elements.roomSelect.append(option);
	}

	if (previousRoom && rooms.includes(previousRoom)) {
		elements.roomSelect.value = previousRoom;
		state.room = previousRoom;
	} else {
		elements.roomSelect.value = '';
		state.room = '';
	}
}

function renderTimeline(history) {
	const svg = elements.timelineChart;
	if (!history.length) {
		svg.innerHTML = '<text x="24" y="34" fill="#6c7784" font-size="16">No timeline data yet.</text>';
		elements.timelineSummary.textContent = 'No samples yet';
		return;
	}

	const width = 900;
	const height = 280;
	const padX = 38;
	const padY = 26;
	const graphWidth = width - padX * 2;
	const graphHeight = height - padY * 2;
	const pointCount = history.length;

	const points = history.map((point, index) => {
		const ratio = clampRatio(point.loadRatio);
		const x = padX + (graphWidth * index) / Math.max(pointCount - 1, 1);
		const y = height - padY - ratio * graphHeight;
		return { x, y };
	});

	const linePath = points
		.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
		.join(' ');
	const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${(height - padY).toFixed(1)} L ${points[0].x.toFixed(1)} ${(height - padY).toFixed(1)} Z`;

	const yTicks = [0, 0.25, 0.5, 0.75, 1];
	const yGrid = yTicks
		.map((tick) => {
			const y = height - padY - tick * graphHeight;
			return `<g><line x1="${padX}" y1="${y}" x2="${width - padX}" y2="${y}" stroke="rgba(78,42,49,0.17)" stroke-width="1"/><text x="6" y="${y + 4}" fill="#74646b" font-size="11">${Math.round(tick * 100)}%</text></g>`;
		})
		.join('');

	const startLabel = formatDateTime(history[0].polledAt);
	const endLabel = formatDateTime(history[history.length - 1].polledAt);
	const latestPoint = points[points.length - 1];

	svg.innerHTML = `
		<defs>
			<linearGradient id="area-fill" x1="0" x2="0" y1="0" y2="1">
				<stop offset="0%" stop-color="rgba(13,154,131,0.36)" />
				<stop offset="100%" stop-color="rgba(13,154,131,0.02)" />
			</linearGradient>
		</defs>
		${yGrid}
		<path d="${areaPath}" fill="url(#area-fill)" />
		<path d="${linePath}" fill="none" stroke="#0d9a83" stroke-width="3" stroke-linecap="round" />
		<circle cx="${latestPoint.x.toFixed(1)}" cy="${latestPoint.y.toFixed(1)}" r="5" fill="#ef7347" />
		<text x="${padX}" y="${height - 4}" fill="#74646b" font-size="11">${startLabel}</text>
		<text x="${width - padX}" y="${height - 4}" text-anchor="end" fill="#74646b" font-size="11">${endLabel}</text>
	`;

	const latestRatio = history[history.length - 1].loadRatio;
	elements.timelineSummary.textContent = `${history.length} samples in view. Latest load: ${formatPercent(latestRatio)}.`;
}

function renderBestTimes(bestTimes) {
	elements.bestTimesList.innerHTML = '';

	if (!bestTimes.length) {
		const empty = document.createElement('li');
		empty.className = 'empty-state';
		empty.textContent = 'Not enough samples yet. Let polling run for a few days.';
		elements.bestTimesList.append(empty);
		return;
	}

	bestTimes.forEach((slot, index) => {
		const item = document.createElement('li');
		item.className = 'best-time-item';
		item.innerHTML = `
			<span class="best-time-rank">${index + 1}</span>
			<div>
				<div class="best-time-slot">${slot.dayLabel} at ${slot.hourLabel}</div>
				<div class="best-time-meta">${slot.sampleSize} samples</div>
			</div>
			<span class="best-time-load">${formatPercent(slot.avgLoadRatio)}</span>
		`;
		elements.bestTimesList.append(item);
	});
}

function renderHeatmap(heatmap) {
	const heatmapIndex = new Map(heatmap.map((cell) => [`${cell.dayOfWeek}-${cell.hourOfDay}`, cell]));

	elements.heatmapGrid.innerHTML = '';

	const corner = document.createElement('div');
	corner.className = 'heatmap-hour-label';
	corner.textContent = '';
	elements.heatmapGrid.append(corner);

	for (const dayLabel of DAY_LABELS) {
		const dayHeader = document.createElement('div');
		dayHeader.className = 'heatmap-day-label';
		dayHeader.textContent = dayLabel;
		elements.heatmapGrid.append(dayHeader);
	}

	for (let hour = 0; hour < 24; hour += 1) {
		const hourLabel = document.createElement('div');
		hourLabel.className = 'heatmap-hour-label';
		hourLabel.textContent = hour % 6 === 0 ? formatHour(hour) : `${hour}`;
		elements.heatmapGrid.append(hourLabel);

		for (let day = 0; day < 7; day += 1) {
			const key = `${day}-${hour}`;
			const cellData = heatmapIndex.get(key);
			const cell = document.createElement('div');
			cell.className = 'heatmap-cell';

			if (!cellData) {
				cell.classList.add('empty');
				cell.title = `${DAY_LABELS[day]} ${formatHour(hour)}: no samples`;
			} else {
				const ratio = clampRatio(cellData.avgLoadRatio);
				cell.style.background = ratioToHeatColor(ratio);
				cell.title = `${DAY_LABELS[day]} ${formatHour(hour)}: ${formatPercent(ratio)} (${cellData.sampleSize} samples)`;
			}

			elements.heatmapGrid.append(cell);
		}
	}
}

function toggleFavorite(roomLabel) {
	state.favorites.has(roomLabel) ? state.favorites.delete(roomLabel) : state.favorites.add(roomLabel);
	localStorage.setItem('favRooms', JSON.stringify([...state.favorites]));

	if (state.latestCurrent) {
		syncRoomOptions(state.latestCurrent.rooms.map(r => r.label));
	}

	const uiIcon = document.querySelector(`.fav-cell[data-room="${roomLabel}"]`);
	if (uiIcon) {
		const isFav = state.favorites.has(roomLabel);
		uiIcon.className = `fav-icon fav-cell ${isFav ? 'active' : 'inactive'}`;
	}
}

function renderRoomTable(currentSnapshot) {
	elements.roomsTableBody.innerHTML = '';

	if (!currentSnapshot || !currentSnapshot.rooms.length) {
		const row = document.createElement('tr');
		row.innerHTML = '<td colspan="5" class="empty-state">No room data yet.</td>';
		elements.roomsTableBody.append(row);
		return;
	}

	const sortedRooms = [...currentSnapshot.rooms].sort((a, b) => {
		const favA = state.favorites.has(a.label);
		const favB = state.favorites.has(b.label);
		return favA === favB ? a.label.localeCompare(b.label) : (favA ? -1 : 1);
	});

	for (const room of sortedRooms) {
		const row = document.createElement('tr');
		const loadColor = ratioToChipColor(room.loadRatio);
		const isFav = state.favorites.has(room.label);
		row.innerHTML = `
			<td class="fav-table-cell"><span class="fav-icon fav-cell ${isFav ? 'active' : 'inactive'}" data-room="${room.label}">❤️</span></td>
			<td>${room.label}</td>
			<td>${room.availableWashers} / ${room.totalWashers}</td>
			<td>${room.availableDryers} / ${room.totalDryers}</td>
			<td><span class="load-chip" style="background: ${loadColor}">${formatPercent(room.loadRatio)}</span></td>
		`;
		elements.roomsTableBody.append(row);
	}
}

function renderFailures(failures) {
	elements.failuresList.innerHTML = '';
	if (!failures.length) {
		const item = document.createElement('li');
		item.className = 'empty-state';
		item.textContent = 'No recent failures.';
		elements.failuresList.append(item);
		return;
	}

	for (const failure of failures) {
		const item = document.createElement('li');
		item.className = 'failure-item';
		item.textContent = `${formatDateTime(failure.polledAt)} - ${failure.errorMessage}`;
		elements.failuresList.append(item);
	}
}

function renderKpis(data) {
	const current = data.current;
	const summary = data.summary;
	const best = data.bestTimes[0] ?? null;

	if (!current) {
		elements.currentLoad.textContent = '--';
		elements.currentCaption.textContent = 'No successful poll yet';
		elements.freeMachines.textContent = '--';
		elements.freeCaption.textContent = 'No successful poll yet';
	} else {
		elements.currentLoad.textContent = formatPercent(current.totals.loadRatio);
		elements.currentCaption.textContent = `${current.totals.totalInUse} in use out of ${current.totals.totalCapacity}`;
		const freeMachines = current.totals.availableWashers + current.totals.availableDryers;
		elements.freeMachines.textContent = String(freeMachines);
		elements.freeCaption.textContent = `${current.totals.availableWashers} washers + ${current.totals.availableDryers} dryers free`;
	}

	if (!best) {
		elements.bestSlot.textContent = '--';
		elements.bestCaption.textContent = 'Collect more data to unlock insights';
	} else {
		elements.bestSlot.textContent = `${best.dayLabel} ${best.hourLabel}`;
		elements.bestCaption.textContent = `${formatPercent(best.avgLoadRatio)} avg load across ${best.sampleSize} samples`;
	}

	elements.averageLoad.textContent = summary.samples > 0 ? formatPercent(summary.averageLoadRatio) : '--';
	if (summary.recentTrendDelta === null) {
		elements.averageCaption.textContent = `${summary.samples} samples in timeline`;
	} else {
		const direction = summary.recentTrendDelta > 0 ? 'busier' : 'quieter';
		elements.averageCaption.textContent = `${Math.abs(Math.round(summary.recentTrendDelta * 100))}% ${direction} vs prior window`;
	}
}

function renderStatus(data) {
	const pollerStatus = data.pollerStatus;
	if (pollerStatus.isPolling) {
		setStatus('warn', 'Polling now');
		return;
	}

	if (pollerStatus.lastError) {
		setStatus('bad', `Poller warning: ${pollerStatus.lastError.slice(0, 80)}`);
		return;
	}

	if (data.current) {
		setStatus('ok', 'Healthy and collecting');
		return;
	}

	setStatus('warn', 'Running, waiting for first successful sample');
}

function renderLastUpdated(data) {
	const generated = formatDateTime(data.generatedAt);
	const sampleAt = formatDateTime(data.current?.polledAt ?? data.pollerStatus.lastSuccessAt);
	elements.lastUpdated.textContent = `Dashboard updated ${generated}. Latest sample: ${sampleAt}.`;
}

function renderDashboard(data) {
	state.latestCurrent = data.current;
	syncRoomOptions(data.rooms);
	renderStatus(data);
	renderLastUpdated(data);
	renderKpis(data);
	renderTimeline(data.history);
	renderBestTimes(data.bestTimes);
	renderHeatmap(data.heatmap);
	renderRoomTable(data.current);
	renderFailures(data.recentFailures);
}

async function loadDashboard() {
	if (state.isLoading) {
		return;
	}

	setLoading(true);
	try {
		const query = getDashboardQuery();
		const response = await fetch(`/api/dashboard?${query.toString()}`, {
			headers: {
				Accept: 'application/json'
			}
		});

		if (!response.ok) {
			throw new Error(`Dashboard request failed with ${response.status}`);
		}

		const data = await response.json();
		renderDashboard(data);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		setStatus('bad', `Refresh failed: ${message}`);
		elements.lastUpdated.textContent = `Last refresh failed at ${new Date().toLocaleTimeString()}`;
	} finally {
		setLoading(false);
	}
}

async function triggerPollNow() {
	if (state.isLoading) {
		return;
	}

	setLoading(true);
	setStatus('warn', 'Triggering poll...');

	try {
		const response = await fetch('/api/poll-now', {
			method: 'POST'
		});

		if (!response.ok) {
			throw new Error(`Poll trigger failed with ${response.status}`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		setStatus('bad', `Poll trigger failed: ${message}`);
	} finally {
		setLoading(false);
	}

	await loadDashboard();
}

function wireEventHandlers() {
	elements.refreshButton.addEventListener('click', () => {
		void loadDashboard();
	});

	elements.pollNowButton.addEventListener('click', () => {
		void triggerPollNow();
	});

	elements.daysSelect.addEventListener('change', () => {
		state.days = Number.parseInt(elements.daysSelect.value, 10) || 21;
		void loadDashboard();
	});

	elements.hoursSelect.addEventListener('change', () => {
		state.hours = Number.parseInt(elements.hoursSelect.value, 10) || 72;
		void loadDashboard();
	});

	elements.roomSelect.addEventListener('change', () => {
		state.room = elements.roomSelect.value;
		void loadDashboard();
	});

	elements.roomsTableBody.addEventListener('click', (e) => {
		const target = e.target.closest('.fav-cell');
		if (target) {
			toggleFavorite(target.dataset.room);
		}
	});
}

wireEventHandlers();
void loadDashboard();

setInterval(() => {
	void loadDashboard();
}, 60_000);
