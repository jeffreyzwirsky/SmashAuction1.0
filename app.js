//
// SMASH Scrap Management – Application Script
//
// This file implements the front‑end logic for the SMASH scrap
// management demo.  The system persists all data in the browser's
// localStorage (no backend required) and supports three roles:
//   • Admin   – manage users, approve sales and view ledger
//   • Manager – create inventory (boxes), parts, auctions, receive bids
//   • Operator – browse auctions and place bids
//
// Demo accounts: admin/admin, manager/manager, operator/operator.

(function(){
    'use strict';

    /*================= Data persistence =================*/

    const STORAGE_KEY = 'smashScrapDB';
    const SESSION_KEY = 'smashScrapUser';

    // Load database from localStorage or initialise a fresh object
    function loadDb() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) return JSON.parse(raw);
        } catch (e) { console.error('Failed to load DB', e); }
        return { users: [], boxes: [], auctions: [], bids: [], ledger: [] };
    }

    // Save database to localStorage
    function saveDb(db) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    }

    // Generate a random ID with prefix
    function makeId(prefix) {
        return prefix + '-' + Math.random().toString(36).substr(2, 9);
    }

    // Get current user object from sessionStorage
    function getCurrentUser(db) {
        const id = sessionStorage.getItem(SESSION_KEY);
        if (!id) return null;
        return db.users.find(u => u.id === id) || null;
    }

    // Set current user in sessionStorage
    function setCurrentUser(user) {
        if (user) sessionStorage.setItem(SESSION_KEY, user.id);
        else sessionStorage.removeItem(SESSION_KEY);
    }

    // Seed demo accounts if none exist.  Admin -> manager -> operator.
    function initDemo(db) {
        if (db.users.length > 0) return;
        const adminId = makeId('USR');
        const managerId = makeId('USR');
        const operatorId = makeId('USR');
        db.users.push({ id: adminId, username: 'admin', password: 'admin', name: 'Administrator', role: 'admin', parentId: '', trustLevel: 5 });
        db.users.push({ id: managerId, username: 'manager', password: 'manager', name: 'Manager', role: 'seller', parentId: adminId, trustLevel: 3 });
        db.users.push({ id: operatorId, username: 'operator', password: 'operator', name: 'Operator', role: 'buyer', parentId: managerId, trustLevel: 0 });
        saveDb(db);
    }

    /*================= DB operations =================*/

    // Create a new user (admin only).  Does basic validation.
    function createUser(db, username, password, name, role, parentId) {
        if (db.users.find(u => u.username === username)) {
            return { error: 'Username already exists' };
        }
        const id = makeId('USR');
        db.users.push({ id, username, password, name, role, parentId: parentId || '', trustLevel: 0 });
        saveDb(db);
        return { user: db.users.find(u => u.id === id) };
    }

    // Create a new box/package for a seller
    function createBox(db, sellerId, data) {
        const id = makeId('BOX');
        const net = data.net || (data.gross - data.tare);
        const box = {
            id,
            sellerId,
            packageName: data.packageName || '',
            material: data.material || '',
            saleUnit: data.saleUnit || 'LB',
            count: data.count || 0,
            gross: data.gross || 0,
            tare: data.tare || 0,
            net: net || 0,
            photos: data.photos || [],
            status: 'WIP',
            parts: []
        };
        db.boxes.push(box);
        saveDb(db);
        return { box };
    }

    // Add a part to a box enforcing single material/type
    function addPart(db, boxId, part) {
        const box = db.boxes.find(b => b.id === boxId);
        if (!box) return { error: 'Box not found' };
        if (box.status !== 'WIP' && box.status !== 'FINISHED') return { error: 'Cannot modify box in auction or sold' };
        if (box.material && part.name && part.name.toLowerCase() !== box.material.toLowerCase()) {
            return { error: `Box is locked to material "${box.material}"` };
        }
        if (!box.material && part.name) box.material = part.name;
        const id = makeId('PRT');
        const newPart = {
            id,
            name: part.name || '',
            photos: part.photos || [],
            fill: part.fill || 0,
            vin: part.vin || '',
            year: part.year || '',
            make: part.make || '',
            model: part.model || '',
            trim: part.trim || '',
            partNumber: part.partNumber || '',
            notes: part.notes || ''
        };
        box.parts.push(newPart);
        saveDb(db);
        return { part: newPart };
    }

    // Finalise a box; status -> FINISHED
    function finalizeBox(db, boxId) {
        const box = db.boxes.find(b => b.id === boxId);
        if (!box) return { error: 'Box not found' };
        if (box.parts.length === 0) return { error: 'Add at least one part before finalising' };
        if (box.status !== 'WIP') return { error: 'Box already finalised or in auction' };
        box.status = 'FINISHED';
        saveDb(db);
        return { box };
    }

    // Update box status (internal)
    function setBoxStatus(db, boxId, status) {
        const box = db.boxes.find(b => b.id === boxId);
        if (box) {
            box.status = status;
        }
    }

    // Create auction for seller using selected FINISHED boxes
    function createAuction(db, sellerId, data) {
        // Validate boxes
        for (const bxId of data.boxIds) {
            const bx = db.boxes.find(b => b.id === bxId);
            if (!bx) return { error: `Box ${bxId} not found` };
            if (bx.status !== 'FINISHED') return { error: `Box ${bxId} not ready for auction` };
        }
        const id = makeId('AUC');
        const auction = {
            id,
            sellerId,
            title: data.title || ('Auction ' + id.slice(-5)),
            shipping: data.shipping || [],
            forkliftOnSite: !!data.forkliftOnSite,
            paymentTerms: data.paymentTerms || [],
            boxIds: data.boxIds.slice(),
            status: 'IN_AUCTION',
            bids: []
        };
        db.auctions.push(auction);
        // Mark boxes as in auction
        auction.boxIds.forEach(bx => setBoxStatus(db, bx, 'IN_AUCTION'));
        saveDb(db);
        return { auction };
    }

    // Submit a bid by buyer for an auction
    function submitBid(db, buyerId, auctionId, offers) {
        const auction = db.auctions.find(a => a.id === auctionId);
        if (!auction) return { error: 'Auction not found' };
        const lineOffers = Object.keys(offers).map(pid => ({ partId: pid, amount: parseFloat(offers[pid] || 0) }));
        const total = lineOffers.reduce((sum, o) => sum + (isNaN(o.amount) ? 0 : o.amount), 0);
        if (total <= 0) return { error: 'Enter at least one offer amount' };
        const id = makeId('BID');
        const bid = {
            id,
            auctionId,
            buyerId,
            lineOffers,
            total,
            status: 'SUBMITTED',
            sellerApproved: false,
            adminApproved: false
        };
        db.bids.push(bid);
        auction.bids.push(bid.id);
        saveDb(db);
        return { bid };
    }

    // Seller accepts or rejects bid
    function setBidSellerStatus(db, bidId, approve) {
        const bid = db.bids.find(b => b.id === bidId);
        if (!bid) return { error: 'Bid not found' };
        if (approve) {
            bid.status = 'SELLER_ACCEPTED';
            bid.sellerApproved = true;
        } else {
            bid.status = 'SELLER_REJECTED';
        }
        saveDb(db);
        return { bid };
    }

    // Admin approves or rejects bid
    function setBidAdminStatus(db, bidId, approve) {
        const bid = db.bids.find(b => b.id === bidId);
        if (!bid) return { error: 'Bid not found' };
        if (bid.status !== 'SELLER_ACCEPTED') return { error: 'Bid must be seller accepted first' };
        const auction = db.auctions.find(a => a.id === bid.auctionId);
        if (!auction) return { error: 'Auction not found' };
        if (approve) {
            bid.status = 'ADMIN_APPROVED';
            bid.adminApproved = true;
            auction.status = 'SOLD';
            // Mark boxes sold and write ledger
            auction.boxIds.forEach(bxId => setBoxStatus(db, bxId, 'SOLD'));
            const sellerId = auction.sellerId;
            const txId = makeId('TX');
            db.ledger.push({ id: txId, sellerId, buyerId: bid.buyerId, auctionId: auction.id, total: bid.total, date: new Date().toISOString() });
        } else {
            bid.status = 'ADMIN_REJECTED';
        }
        saveDb(db);
        return { bid };
    }

    /*================= UI Elements =================*/

    const loginScreen = document.getElementById('login-screen');
    const loginForm = document.getElementById('login-form');
    const appContainer = document.getElementById('app');
    const sidebar = document.getElementById('sidebar');
    const mainContent = document.getElementById('main-content');
    const userNameEl = document.getElementById('user-name');
    const userRoleEl = document.getElementById('user-role');
    const logoutBtn = document.getElementById('logout-btn');

    const demoButtons = document.querySelectorAll('.demo-btn');

    /*================= Rendering functions =================*/

    // Render the sidebar based on current user's role
    function renderSidebar(user) {
        sidebar.innerHTML = '';
        const frag = document.createDocumentFragment();

        function addSection(title, items) {
            const h = document.createElement('h3');
            h.textContent = title;
            frag.appendChild(h);
            const ul = document.createElement('ul');
            ul.className = 'nav-menu';
            items.forEach(item => {
                // Only show if role matches (if roles defined)
                if (item.roles && !item.roles.includes(user.role)) return;
                const li = document.createElement('li');
                const a = document.createElement('a');
                a.href = '#';
                a.dataset.module = item.id;
                a.innerHTML = `<i class="${item.icon}"></i> ${item.label}`;
                a.addEventListener('click', ev => {
                    ev.preventDefault();
                    setActiveModule(item.id);
                });
                li.appendChild(a);
                ul.appendChild(li);
            });
            frag.appendChild(ul);
        }

        // Define navigation structure
        const navDef = [
            { title: 'Core', items: [
                { id: 'dashboard', label: 'Dashboard', icon: 'fas fa-tachometer-alt', roles: ['admin','seller','buyer'] },
                { id: 'inventory', label: 'Inventory', icon: 'fas fa-boxes', roles: ['seller'] },
                { id: 'auctions', label: 'Auctions', icon: 'fas fa-gavel', roles: ['seller','buyer'] },
                { id: 'bidsReceived', label: 'Bids', icon: 'fas fa-envelope-open-text', roles: ['seller'] },
                { id: 'mybids', label: 'My Bids', icon: 'fas fa-receipt', roles: ['buyer'] }
            ] },
            { title: 'Admin', items: [
                { id: 'approvals', label: 'Approvals', icon: 'fas fa-check-circle', roles: ['admin'] },
                { id: 'users', label: 'Users', icon: 'fas fa-users-cog', roles: ['admin'] },
                { id: 'ledger', label: 'Ledger', icon: 'fas fa-file-invoice-dollar', roles: ['admin'] }
            ] }
        ];
        navDef.forEach(section => addSection(section.title, section.items));
        sidebar.appendChild(frag);
        highlightActiveLink();
    }

    // Highlight the currently active link
    function highlightActiveLink() {
        const links = sidebar.querySelectorAll('a');
        links.forEach(link => {
            if (link.dataset.module === currentModule) link.classList.add('active');
            else link.classList.remove('active');
        });
    }

    // Display a module in the main content area
    function showModule(moduleId) {
        currentModule = moduleId;
        highlightActiveLink();
        mainContent.innerHTML = '';
        const user = getCurrentUser(db);
        if (!user) return;
        switch(moduleId) {
            case 'dashboard':
                renderDashboard(user);
                break;
            case 'inventory':
                renderInventory(user);
                break;
            case 'auctions':
                if (user.role === 'seller') renderSellerAuctions(user);
                else if (user.role === 'buyer') renderMarketplace(user);
                else renderDashboard(user);
                break;
            case 'bidsReceived':
                renderBidsReceived(user);
                break;
            case 'mybids':
                renderMyBids(user);
                break;
            case 'approvals':
                renderApprovals(user);
                break;
            case 'users':
                renderUserManagement(user);
                break;
            case 'ledger':
                renderLedger(user);
                break;
            default:
                renderDashboard(user);
                break;
        }
    }

    /*================= Module renderers =================*/

    // Dashboard summary
    function renderDashboard(user) {
        const section = document.createElement('div');
        section.className = 'module';
        const rolePretty = { 'admin':'Administrator', 'seller':'Manager', 'buyer':'Operator' };
        section.innerHTML = `<h2>Welcome, ${user.name || user.username}</h2>
            <p>Your role: <strong>${rolePretty[user.role] || user.role}</strong></p>`;
        // Show quick stats based on role
        if (user.role === 'seller') {
            const myBoxes = db.boxes.filter(b => b.sellerId === user.id);
            const finished = myBoxes.filter(b => b.status === 'FINISHED').length;
            const wip = myBoxes.filter(b => b.status === 'WIP').length;
            const inAuc = myBoxes.filter(b => b.status === 'IN_AUCTION').length;
            const sold = myBoxes.filter(b => b.status === 'SOLD').length;
            section.innerHTML += `<p>Boxes summary:</p>
                <ul>
                  <li>WIP: ${wip}</li>
                  <li>Finished: ${finished}</li>
                  <li>In Auction: ${inAuc}</li>
                  <li>Sold: ${sold}</li>
                </ul>`;
        } else if (user.role === 'buyer') {
            const myBids = db.bids.filter(b => b.buyerId === user.id);
            const pending = myBids.filter(b => b.status === 'SUBMITTED').length;
            const accepted = myBids.filter(b => b.status === 'ADMIN_APPROVED').length;
            const rejected = myBids.filter(b => ['SELLER_REJECTED','ADMIN_REJECTED'].includes(b.status)).length;
            section.innerHTML += `<p>Bids summary:</p>
                <ul>
                  <li>Pending: ${pending}</li>
                  <li>Approved: ${accepted}</li>
                  <li>Rejected: ${rejected}</li>
                </ul>`;
        } else if (user.role === 'admin') {
            const pending = db.bids.filter(b => b.status === 'SELLER_ACCEPTED').length;
            const totalUsers = db.users.length;
            section.innerHTML += `<p>System summary:</p>
                <ul>
                  <li>Pending approvals: ${pending}</li>
                  <li>Total users: ${totalUsers}</li>
                  <li>Total auctions: ${db.auctions.length}</li>
                </ul>`;
        }
        mainContent.appendChild(section);
    }

    // Inventory management for sellers
    function renderInventory(user) {
        const wrapper = document.createElement('div');
        // Section: list boxes
        const boxSection = document.createElement('div');
        boxSection.className = 'module';
        boxSection.innerHTML = '<h2>My Boxes</h2>';
        const myBoxes = db.boxes.filter(b => b.sellerId === user.id);
        if (myBoxes.length === 0) {
            boxSection.innerHTML += '<p>You have no boxes. Use the form below to create one.</p>';
        } else {
            const table = document.createElement('table');
            table.innerHTML = '<thead><tr><th>ID</th><th>Name / Material</th><th>Unit</th><th>Count</th><th>Gross</th><th>Net</th><th>Status</th><th>Actions</th></tr></thead>';
            const tbody = document.createElement('tbody');
            myBoxes.forEach(bx => {
                const tr = document.createElement('tr');
                const name = bx.packageName || '';
                const mat = bx.material || '';
                tr.innerHTML = `<td>${bx.id}</td><td>${name ? name + ' / ' : ''}${mat}</td><td>${bx.saleUnit}</td><td>${bx.count}</td><td>${bx.gross}</td><td>${bx.net}</td><td><span class="status-badge status-${bx.status}">${bx.status}</span></td><td></td>`;
                const actions = tr.querySelector('td:last-child');
                if (bx.status === 'WIP') {
                    const addBtn = document.createElement('button');
                    addBtn.className = 'btn btn-secondary small';
                    addBtn.textContent = 'Add Part';
                    addBtn.addEventListener('click', () => {
                        renderAddPart(user, bx.id);
                    });
                    const finBtn = document.createElement('button');
                    finBtn.className = 'btn btn-secondary small';
                    finBtn.textContent = 'Finalize';
                    finBtn.addEventListener('click', () => {
                        const res = finalizeBox(db, bx.id);
                        if (res.error) alert(res.error);
                        else alert('Box finalised');
                        refreshModule();
                    });
                    actions.appendChild(addBtn);
                    actions.appendChild(finBtn);
                } else if (bx.status === 'FINISHED') {
                    actions.textContent = 'Ready for auction';
                } else if (bx.status === 'IN_AUCTION') {
                    actions.textContent = 'In auction';
                } else if (bx.status === 'SOLD') {
                    actions.textContent = 'Sold';
                }
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            boxSection.appendChild(table);
        }
        wrapper.appendChild(boxSection);
        // Section: create box form
        const formSection = document.createElement('div');
        formSection.className = 'module';
        formSection.innerHTML = '<h2>Create Box</h2>';
        const form = document.createElement('div');
        form.className = 'form';
        form.innerHTML = `
            <div class="form-row">
                <div>
                    <label>Package Name</label>
                    <input type="text" id="bxName" placeholder="e.g., Mixed Converters">
                </div>
                <div>
                    <label>Material</label>
                    <select id="bxMaterial">
                        <option value="">--Select--</option>
                        ${SCRAP_MATERIALS.map(m => `<option>${m}</option>`).join('')}
                    </select>
                </div>
                <div>
                    <label>Unit</label>
                    <select id="bxUnit"><option value="LB">LB</option><option value="PC">PC</option></select>
                </div>
            </div>
            <div class="form-row">
                <div><label>Count</label><input type="number" id="bxCount" value="0" min="0"></div>
                <div><label>Gross</label><input type="number" id="bxGross" value="0" step="0.01"></div>
                <div><label>Tare</label><input type="number" id="bxTare" value="0" step="0.01"></div>
            </div>
            <div class="form-row">
                <div><label>Photos (max 5)</label><input type="file" id="bxPhotos" multiple accept="image/*"></div>
            </div>
            <div class="flex-buttons">
                <button class="btn btn-primary small" id="createBoxBtn">Create</button>
            </div>
        `;
        formSection.appendChild(form);
        wrapper.appendChild(formSection);
        mainContent.appendChild(wrapper);
        // Event: create box
        document.getElementById('createBoxBtn').addEventListener('click', async () => {
            const pkgName = document.getElementById('bxName').value.trim();
            const material = document.getElementById('bxMaterial').value;
            const unit = document.getElementById('bxUnit').value;
            const count = parseFloat(document.getElementById('bxCount').value) || 0;
            const gross = parseFloat(document.getElementById('bxGross').value) || 0;
            const tare = parseFloat(document.getElementById('bxTare').value) || 0;
            const files = Array.from(document.getElementById('bxPhotos').files || []);
            const photos = [];
            for (let i = 0; i < Math.min(files.length, 5); i++) {
                photos.push(await fileToDataURL(files[i]));
            }
            const res = createBox(db, user.id, { packageName: pkgName, material, saleUnit: unit, count, gross, tare, photos });
            alert('Box created: ' + res.box.id);
            refreshModule();
        });
    }

    // Render the add part form for a given box
    function renderAddPart(user, boxId) {
        const box = db.boxes.find(b => b.id === boxId);
        if (!box) return;
        mainContent.innerHTML = '';
        const mod = document.createElement('div');
        mod.className = 'module';
        mod.innerHTML = `<h2>Add Part to Box ${box.id}</h2>`;
        const form = document.createElement('div');
        form.className = 'form';
        form.innerHTML = `
            <div class="form-row">
                <div>
                    <label>Material / Part</label>
                    <select id="ptName">
                        ${SCRAP_MATERIALS.concat(CAR_PARTS).map(p => `<option>${p}</option>`).join('')}
                    </select>
                </div>
                <div>
                    <label>Fill Level (%)</label>
                    <input type="number" id="ptFill" value="0" min="0" max="100">
                </div>
                <div>
                    <label>VIN</label>
                    <input type="text" id="ptVIN">
                </div>
            </div>
            <div class="form-row">
                <div><label>Year</label><input type="text" id="ptYear"></div>
                <div><label>Make</label><input type="text" id="ptMake"></div>
                <div><label>Model</label><input type="text" id="ptModel"></div>
                <div><label>Trim</label><input type="text" id="ptTrim"></div>
            </div>
            <div class="form-row">
                <div><label>Part Number</label><input type="text" id="ptPartNumber"></div>
                <div><label>Notes</label><input type="text" id="ptNotes"></div>
            </div>
            <div class="form-row">
                <div><label>Photos (max 5)</label><input type="file" id="ptPhotos" multiple accept="image/*"></div>
            </div>
            <div class="flex-buttons">
                <button class="btn btn-primary small" id="addPartBtn">Add Part</button>
                <button class="btn btn-secondary small" id="backBtn">Back</button>
            </div>
        `;
        mod.appendChild(form);
        mainContent.appendChild(mod);
        document.getElementById('backBtn').addEventListener('click', () => { refreshModule(); });
        document.getElementById('addPartBtn').addEventListener('click', async () => {
            const name = document.getElementById('ptName').value;
            const fill = parseFloat(document.getElementById('ptFill').value) || 0;
            const vin = document.getElementById('ptVIN').value.trim();
            const year = document.getElementById('ptYear').value.trim();
            const make = document.getElementById('ptMake').value.trim();
            const model = document.getElementById('ptModel').value.trim();
            const trim = document.getElementById('ptTrim').value.trim();
            const partNumber = document.getElementById('ptPartNumber').value.trim();
            const notes = document.getElementById('ptNotes').value.trim();
            const files = Array.from(document.getElementById('ptPhotos').files || []);
            const photos = [];
            for (let i = 0; i < Math.min(files.length, 5); i++) {
                photos.push(await fileToDataURL(files[i]));
            }
            const res = addPart(db, boxId, { name, fill, vin, year, make, model, trim, partNumber, notes, photos });
            if (res.error) alert(res.error);
            else alert('Part added');
            refreshModule();
        });
    }

    // Auctions management for seller
    function renderSellerAuctions(user) {
        const wrapper = document.createElement('div');
        // List existing auctions
        const listSec = document.createElement('div');
        listSec.className = 'module';
        listSec.innerHTML = '<h2>My Auctions</h2>';
        const myAuctions = db.auctions.filter(a => a.sellerId === user.id);
        if (myAuctions.length === 0) {
            listSec.innerHTML += '<p>No auctions yet.</p>';
        } else {
            const table = document.createElement('table');
            table.innerHTML = '<thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Boxes</th><th>Bids</th></tr></thead>';
            const tbody = document.createElement('tbody');
            myAuctions.forEach(a => {
                const tr = document.createElement('tr');
                tr.innerHTML = `<td>${a.id}</td><td>${a.title}</td><td>${a.status}</td><td>${a.boxIds.length}</td><td>${a.bids.length}</td>`;
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            listSec.appendChild(table);
        }
        wrapper.appendChild(listSec);
        // Create auction form
        const formSec = document.createElement('div');
        formSec.className = 'module';
        formSec.innerHTML = '<h2>Create Auction</h2>';
        // get finished boxes
        const finished = db.boxes.filter(b => b.sellerId === user.id && b.status === 'FINISHED');
        if (finished.length === 0) {
            formSec.innerHTML += '<p>No finished boxes ready for auction.</p>';
        } else {
            formSec.innerHTML += `
                <div class="form-row">
                    <div>
                        <label>Title</label>
                        <input type="text" id="aucTitle" placeholder="Optional title">
                    </div>
                </div>
                <div class="form-row">
                    <div>
                        <label>Select Boxes</label>
                        <div id="boxSelectList" style="max-height:150px;overflow-y:auto;border:1px solid var(--border-colour);padding:6px;border-radius:6px;">
                            ${finished.map(b => `<div><input type="checkbox" id="sel-${b.id}" value="${b.id}"> ${b.id} (${b.material}, Net ${b.net})</div>`).join('')}
                        </div>
                    </div>
                </div>
                <div class="form-row">
                    <div>
                        <label>Shipping</label>
                        ${SHIPPING_OPTIONS.map(opt => `<label style="display:block"><input type="checkbox" class="shipOption" value="${opt}"> ${opt}</label>`).join('')}
                    </div>
                    <div>
                        <label>Forklift On Site</label>
                        <select id="forklift"><option value="yes">Yes</option><option value="no">No</option></select>
                    </div>
                    <div>
                        <label>Payment Terms</label>
                        ${PAYMENT_TERMS.map(opt => `<label style="display:block"><input type="checkbox" class="payOption" value="${opt}"> ${opt}</label>`).join('')}
                    </div>
                </div>
                <div class="flex-buttons">
                    <button class="btn btn-primary small" id="createAuctionBtn">Create Auction</button>
                </div>
            `;
        }
        wrapper.appendChild(formSec);
        mainContent.appendChild(wrapper);
        const createBtn = document.getElementById('createAuctionBtn');
        if (createBtn) {
            createBtn.addEventListener('click', () => {
                const title = document.getElementById('aucTitle').value.trim();
                const boxIds = [];
                finished.forEach(b => {
                    const cb = document.getElementById('sel-' + b.id);
                    if (cb && cb.checked) boxIds.push(b.id);
                });
                if (boxIds.length === 0) { alert('Select at least one box.'); return; }
                const shipping = Array.from(document.querySelectorAll('.shipOption:checked')).map(el => el.value);
                const forklift = document.getElementById('forklift').value === 'yes';
                const paymentTerms = Array.from(document.querySelectorAll('.payOption:checked')).map(el => el.value);
                const res = createAuction(db, user.id, { title, shipping, forkliftOnSite: forklift, paymentTerms, boxIds });
                if (res.error) alert(res.error);
                else alert('Auction created: ' + res.auction.id);
                refreshModule();
            });
        }
    }

    // Bids received by seller
    function renderBidsReceived(user) {
        const mod = document.createElement('div');
        mod.className = 'module';
        mod.innerHTML = '<h2>Bids Received</h2>';
        // get seller's auctions and their bids
        const sellerAuctions = db.auctions.filter(a => a.sellerId === user.id);
        const sellerBidIds = sellerAuctions.flatMap(a => a.bids);
        const bids = db.bids.filter(b => sellerBidIds.includes(b.id));
        if (bids.length === 0) {
            mod.innerHTML += '<p>No bids received.</p>';
        } else {
            const table = document.createElement('table');
            table.innerHTML = '<thead><tr><th>Bid ID</th><th>Auction</th><th>Buyer</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead>';
            const tbody = document.createElement('tbody');
            bids.forEach(b => {
                const tr = document.createElement('tr');
                const buyer = db.users.find(u => u.id === b.buyerId);
                tr.innerHTML = `<td>${b.id}</td><td>${b.auctionId}</td><td>${buyer ? buyer.name : b.buyerId}</td><td>${b.total.toFixed(2)}</td><td>${b.status}</td><td></td>`;
                const actions = tr.querySelector('td:last-child');
                if (b.status === 'SUBMITTED') {
                    const acceptBtn = document.createElement('button');
                    acceptBtn.className = 'btn btn-primary small';
                    acceptBtn.textContent = 'Accept';
                    acceptBtn.addEventListener('click', () => {
                        setBidSellerStatus(db, b.id, true);
                        refreshModule();
                    });
                    const rejectBtn = document.createElement('button');
                    rejectBtn.className = 'btn btn-secondary small';
                    rejectBtn.textContent = 'Reject';
                    rejectBtn.addEventListener('click', () => {
                        setBidSellerStatus(db, b.id, false);
                        refreshModule();
                    });
                    actions.appendChild(acceptBtn);
                    actions.appendChild(rejectBtn);
                } else {
                    actions.textContent = '—';
                }
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            mod.appendChild(table);
        }
        mainContent.appendChild(mod);
    }

    // Marketplace for buyers (Auctions)
    function renderMarketplace(user) {
        const auctions = db.auctions.filter(a => a.status === 'IN_AUCTION');
        if (auctions.length === 0) {
            const mod = document.createElement('div');
            mod.className = 'module';
            mod.innerHTML = '<h2>Marketplace</h2><p>No active auctions.</p>';
            mainContent.appendChild(mod);
            return;
        }
        auctions.forEach(auc => {
            const card = document.createElement('div');
            card.className = 'module';
            card.innerHTML = `<h2>${auc.title} (ID: ${auc.id})</h2>`;
            // Show boxes
            auc.boxIds.forEach(bxId => {
                const bx = db.boxes.find(b => b.id === bxId);
                if (!bx) return;
                const boxDiv = document.createElement('div');
                boxDiv.style.border = '1px solid var(--border-colour)';
                boxDiv.style.borderRadius = '8px';
                boxDiv.style.margin = '8px 0';
                boxDiv.style.padding = '8px';
                boxDiv.innerHTML = `<strong>Box ${bx.id}</strong> – ${bx.material} (Net ${bx.net})`;
                // Table of parts with input for offers
                if (bx.parts.length === 0) {
                    boxDiv.innerHTML += '<p><em>No parts listed</em></p>';
                } else {
                    const pTable = document.createElement('table');
                    pTable.innerHTML = '<thead><tr><th>Part ID</th><th>Name</th><th>Fill</th><th>Offer</th></tr></thead>';
                    const ptbody = document.createElement('tbody');
                    bx.parts.forEach(pr => {
                        const tr = document.createElement('tr');
                        tr.innerHTML = `<td>${pr.id}</td><td>${pr.name}</td><td>${pr.fill}</td><td><input type="number" data-offer="${pr.id}" min="0" step="0.01" style="width:80px;"></td>`;
                        ptbody.appendChild(tr);
                    });
                    pTable.appendChild(ptbody);
                    boxDiv.appendChild(pTable);
                }
                card.appendChild(boxDiv);
            });
            // Submit button
            const submitBtn = document.createElement('button');
            submitBtn.className = 'btn btn-primary small';
            submitBtn.textContent = 'Submit Bid';
            submitBtn.addEventListener('click', () => {
                const inputs = card.querySelectorAll('input[data-offer]');
                const offers = {};
                inputs.forEach(inp => {
                    const v = parseFloat(inp.value);
                    if (!isNaN(v) && v > 0) offers[inp.dataset.offer] = v;
                });
                const res = submitBid(db, user.id, auc.id, offers);
                if (res.error) alert(res.error);
                else alert('Bid submitted');
            });
            card.appendChild(submitBtn);
            mainContent.appendChild(card);
        });
    }

    // My bids for buyer
    function renderMyBids(user) {
        const bids = db.bids.filter(b => b.buyerId === user.id);
        const mod = document.createElement('div');
        mod.className = 'module';
        mod.innerHTML = '<h2>My Bids</h2>';
        if (bids.length === 0) {
            mod.innerHTML += '<p>No bids placed.</p>';
        } else {
            const table = document.createElement('table');
            table.innerHTML = '<thead><tr><th>Bid ID</th><th>Auction</th><th>Total</th><th>Status</th></tr></thead>';
            const tbody = document.createElement('tbody');
            bids.forEach(b => {
                const tr = document.createElement('tr');
                tr.innerHTML = `<td>${b.id}</td><td>${b.auctionId}</td><td>${b.total.toFixed(2)}</td><td>${b.status}</td>`;
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            mod.appendChild(table);
        }
        mainContent.appendChild(mod);
    }

    // Approvals for admin
    function renderApprovals(user) {
        const bids = db.bids.filter(b => b.status === 'SELLER_ACCEPTED');
        const mod = document.createElement('div');
        mod.className = 'module';
        mod.innerHTML = '<h2>Pending Approvals</h2>';
        if (bids.length === 0) {
            mod.innerHTML += '<p>No bids awaiting approval.</p>';
        } else {
            const table = document.createElement('table');
            table.innerHTML = '<thead><tr><th>Bid ID</th><th>Auction</th><th>Seller</th><th>Buyer</th><th>Total</th><th>Actions</th></tr></thead>';
            const tbody = document.createElement('tbody');
            bids.forEach(b => {
                const auc = db.auctions.find(a => a.id === b.auctionId);
                const seller = db.users.find(u => u.id === (auc ? auc.sellerId : ''));
                const buyer = db.users.find(u => u.id === b.buyerId);
                const tr = document.createElement('tr');
                tr.innerHTML = `<td>${b.id}</td><td>${b.auctionId}</td><td>${seller ? seller.name : ''}</td><td>${buyer ? buyer.name : ''}</td><td>${b.total.toFixed(2)}</td><td></td>`;
                const actions = tr.querySelector('td:last-child');
                const approveBtn = document.createElement('button');
                approveBtn.className = 'btn btn-primary small';
                approveBtn.textContent = 'Approve';
                approveBtn.addEventListener('click', () => {
                    setBidAdminStatus(db, b.id, true);
                    refreshModule();
                });
                const rejectBtn = document.createElement('button');
                rejectBtn.className = 'btn btn-secondary small';
                rejectBtn.textContent = 'Reject';
                rejectBtn.addEventListener('click', () => {
                    setBidAdminStatus(db, b.id, false);
                    refreshModule();
                });
                actions.appendChild(approveBtn);
                actions.appendChild(rejectBtn);
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            mod.appendChild(table);
        }
        mainContent.appendChild(mod);
    }

    // User management for admin
    function renderUserManagement(user) {
        const mod = document.createElement('div');
        mod.className = 'module';
        mod.innerHTML = '<h2>User Management</h2>';
        // List users
        const table = document.createElement('table');
        table.innerHTML = '<thead><tr><th>ID</th><th>Username</th><th>Name</th><th>Role</th><th>Parent</th></tr></thead>';
        const tbody = document.createElement('tbody');
        db.users.forEach(u => {
            const parent = db.users.find(p => p.id === u.parentId);
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${u.id}</td><td>${u.username}</td><td>${u.name}</td><td>${u.role}</td><td>${parent ? parent.username : ''}</td>`;
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        mod.appendChild(table);
        // Create user form
        const form = document.createElement('div');
        form.className = 'form';
        form.innerHTML = `
            <div class="form-row">
                <div><label>Username</label><input type="text" id="newUsername"></div>
                <div><label>Password</label><input type="text" id="newPassword"></div>
            </div>
            <div class="form-row">
                <div><label>Name</label><input type="text" id="newName"></div>
                <div>
                    <label>Role</label>
                    <select id="newRole">
                        <option value="seller">Manager</option>
                        <option value="buyer">Operator</option>
                        <option value="admin">Admin</option>
                    </select>
                </div>
                <div><label>Parent ID (optional)</label><input type="text" id="newParent"></div>
            </div>
            <div class="flex-buttons">
                <button class="btn btn-primary small" id="createUserBtn">Create User</button>
            </div>
        `;
        mod.appendChild(form);
        mainContent.appendChild(mod);
        // Event to create user
        document.getElementById('createUserBtn').addEventListener('click', () => {
            const username = document.getElementById('newUsername').value.trim();
            const password = document.getElementById('newPassword').value.trim();
            const name = document.getElementById('newName').value.trim();
            const role = document.getElementById('newRole').value;
            const parentId = document.getElementById('newParent').value.trim();
            if (!username || !password || !name) { alert('Please complete all fields.'); return; }
            const res = createUser(db, username, password, name, role, parentId);
            if (res.error) alert(res.error);
            else alert('User created');
            refreshModule();
        });
    }

    // Ledger for admin
    function renderLedger(user) {
        const mod = document.createElement('div');
        mod.className = 'module';
        mod.innerHTML = '<h2>Ledger</h2>';
        if (db.ledger.length === 0) {
            mod.innerHTML += '<p>No ledger entries.</p>';
        } else {
            const table = document.createElement('table');
            table.innerHTML = '<thead><tr><th>Tx ID</th><th>Seller</th><th>Buyer</th><th>Auction</th><th>Total</th><th>Date</th></tr></thead>';
            const tbody = document.createElement('tbody');
            db.ledger.forEach(tx => {
                const seller = db.users.find(u => u.id === tx.sellerId);
                const buyer = db.users.find(u => u.id === tx.buyerId);
                const tr = document.createElement('tr');
                tr.innerHTML = `<td>${tx.id}</td><td>${seller ? seller.username : ''}</td><td>${buyer ? buyer.username : ''}</td><td>${tx.auctionId}</td><td>${tx.total.toFixed(2)}</td><td>${new Date(tx.date).toLocaleString()}</td>`;
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            mod.appendChild(table);
        }
        mainContent.appendChild(mod);
    }

    /*================= Helpers =================*/

    // Convert File object to base64 Data URL
    function fileToDataURL(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    // Refresh current module after data update
    function refreshModule() {
        showModule(currentModule);
    }

    // Set active module and render
    function setActiveModule(moduleId) {
        currentModule = moduleId;
        showModule(moduleId);
    }

    /*================= Application bootstrap =================*/

    let db = loadDb();
    initDemo(db);
    let currentModule = 'dashboard';

    // Bind login form submit
    loginForm.addEventListener('submit', ev => {
        ev.preventDefault();
        const username = document.getElementById('login-username').value.trim();
        const password = document.getElementById('login-password').value.trim();
        const user = db.users.find(u => u.username === username && u.password === password);
        if (!user) {
            alert('Invalid credentials');
            return;
        }
        setCurrentUser(user);
        loginScreen.classList.add('hidden');
        appContainer.classList.remove('hidden');
        userNameEl.textContent = user.name || user.username;
        userRoleEl.textContent = { 'admin':'Administrator', 'seller':'Manager', 'buyer':'Operator' }[user.role] || user.role;
        renderSidebar(user);
        showModule('dashboard');
    });

    // Bind demo buttons to auto-fill login form and submit
    demoButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('login-username').value = btn.dataset.user;
            document.getElementById('login-password').value = btn.dataset.pass;
        });
    });

    // Bind logout button
    logoutBtn.addEventListener('click', () => {
        setCurrentUser(null);
        appContainer.classList.add('hidden');
        loginScreen.classList.remove('hidden');
        currentModule = 'dashboard';
    });

    // On page load: if session exists, show app
    window.addEventListener('DOMContentLoaded', () => {
        const user = getCurrentUser(db);
        if (user) {
            loginScreen.classList.add('hidden');
            appContainer.classList.remove('hidden');
            userNameEl.textContent = user.name || user.username;
            userRoleEl.textContent = { 'admin':'Administrator', 'seller':'Manager', 'buyer':'Operator' }[user.role] || user.role;
            renderSidebar(user);
            showModule('dashboard');
        }
    });

    // Global constants for scrap materials and car parts
    const SCRAP_MATERIALS = [
        'Shred Feed (Light Iron)','HMS 1','HMS 2','Plate & Structural','Cast Iron',
        'Prepared Steel','Rotors/Auto Cast','White Goods','Tin/Sheet Metal','Stainless',
        'Aluminum Extrusion','Aluminum Cast','Aluminum Rims','Copper #1','Copper #2',
        'Brass (Yellow)','Insulated Wire (Hi)','Insulated Wire (Low)','Batteries (Lead)','Catalytic Converters'
    ];
    const CAR_PARTS = [
        'Whole Vehicle','Catalytic Converter','Engine (Complete)','Transmission','Transfer Case',
        'Radiator','AC Compressor','Alternator','Starter','Wiring Harness'
    ];
    const SHIPPING_OPTIONS = ['Picked Up','Delivered','Split Freight'];
    const PAYMENT_TERMS = ['COD','Prepay','Net7','Net15'];
})();