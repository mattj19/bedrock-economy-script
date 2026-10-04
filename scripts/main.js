import { world, system, ItemStack } from "@minecraft/server";

const OBJECTIVE_NAME = "money";

function getMoneyObjective() {
    let obj = world.scoreboard.getObjective(OBJECTIVE_NAME);
    if (!obj) {
        obj = world.scoreboard.addObjective(OBJECTIVE_NAME, "Balance");
    }
    return obj;
}

function getBalance(playerName) {
    const obj = getMoneyObjective();
    try {
        return obj.getScore(playerName) || 0;
    } catch (e) {
        return 0;
    }
}

function setBalance(playerName, amount) {
    const obj = getMoneyObjective();
    obj.setScore(playerName, amount);
}

// Give $500 to new players when they join
world.afterEvents.playerSpawn.subscribe((event) => {
    if (!event.initialSpawn) return;
    
    const player = event.player;
    const obj = getMoneyObjective();
    
    if (!obj.hasParticipant(player)) {
        obj.setScore(player, 500);
        player.sendMessage("§aWelcome! You have been given a $500 starting balance.");
    }
});

world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    const { block, player } = event;
    const signComp = block.getComponent("minecraft:sign");
    
    if (!signComp) {
        if (block.typeId === "minecraft:chest" || block.typeId === "minecraft:barrel") {
            const lockKey = "shop_lock_" + block.x + "_" + block.y + "_" + block.z;
            const owner = world.getDynamicProperty(lockKey);
            if (owner && player.name !== owner && !player.hasTag("admin")) {
                event.cancel = true; 
                system.run(() => {
                    player.sendMessage("§cThis shop is locked by " + owner + ".");
                    player.playSound("note.bass");
                });
            }
        }
        return;
    }

    let text = "";
    try { text = signComp.getText(); } catch (e) { return; }
    
    const lines = text.split("\n");
    if (lines.length < 4) return;

    const header = lines[0].toLowerCase();
    
    const validRawHeaders = ["[shop]", "[sell]", "[adminshop]", "[adminsell]"];
    const isInitializedShop = header.includes("§9[shop]") || header.includes("§c[sell]") || header.includes("§5[adminshop]") || header.includes("§5[adminsell]");
    
    if (validRawHeaders.includes(header) || isInitializedShop) {
        event.cancel = true;
        
        if (validRawHeaders.includes(header)) {
            const type = header.replace("[", "").replace("]", ""); 
            system.run(() => initializeShop(player, block, lines, type));
        } else if (header.includes("§9[shop]")) {
            system.run(() => processTransaction(player, block, lines, "buy"));
        } else if (header.includes("§c[sell]")) {
            system.run(() => processTransaction(player, block, lines, "sell"));
        } else if (header.includes("§5[adminshop]")) {
            system.run(() => processTransaction(player, block, lines, "adminbuy"));
        } else if (header.includes("§5[adminsell]")) {
            system.run(() => processTransaction(player, block, lines, "adminsell"));
        }
    }
});

world.beforeEvents.playerBreakBlock.subscribe((event) => {
    const { block, player } = event;
    
    if (block.typeId.includes("sign")) {
        const signComp = block.getComponent("minecraft:sign");
        if (signComp) {
            let text = "";
            try { text = signComp.getText(); } catch (e) {}
            if (text.includes("§5[AdminShop]") || text.includes("§5[AdminSell]")) {
                if (!player.hasTag("admin")) {
                    event.cancel = true;
                    system.run(() => {
                        player.sendMessage("§cYou cannot break an Admin Shop.");
                        player.playSound("note.bass");
                    });
                    return;
                }
            }
        }
    }

    let chestBlock = null;
    if (block.typeId === "minecraft:chest" || block.typeId === "minecraft:barrel") {
        chestBlock = block;
    } else if (block.typeId.includes("sign")) {
        const belowBlock = block.dimension.getBlock({x: block.x, y: block.y - 1, z: block.z});
        if (belowBlock && (belowBlock.typeId === "minecraft:chest" || belowBlock.typeId === "minecraft:barrel")) {
            chestBlock = belowBlock;
        }
    }

    if (chestBlock) {
        const lockKey = "shop_lock_" + chestBlock.x + "_" + chestBlock.y + "_" + chestBlock.z;
        const owner = world.getDynamicProperty(lockKey);

        if (owner) {
            if (player.name !== owner && !player.hasTag("admin")) {
                event.cancel = true;
                system.run(() => {
                    player.sendMessage("§cYou cannot break " + owner + "'s shop.");
                    player.playSound("note.bass");
                });
            } else {
                system.run(() => world.setDynamicProperty(lockKey, undefined));
            }
        }
    }
});

// --- Helper Functions ---

function toNiceName(id) {
    return id.replace("minecraft:", "")
             .split("_")
             .map(word => word.charAt(0).toUpperCase() + word.slice(1))
             .join(" ");
}

function toIdName(niceName) {
    let id = niceName.toLowerCase().replace(/ /g, "_");
    return id.includes(":") ? id : "minecraft:" + id;
}

function initializeShop(player, signBlock, lines, type) {
    const amount = parseInt(lines[1]);
    const price = parseInt(lines[2]);
    const fullItemName = toIdName(lines[3].trim()); 

    if (isNaN(amount) || isNaN(price) || amount <= 0 || price <= 0) {
        player.sendMessage("§cInvalid shop! Format -> L2: Amount, L3: Price, L4: Item Name");
        player.playSound("note.bass");
        return;
    }

    const isAdminShop = type === "adminshop" || type === "adminsell";

    if (isAdminShop && !player.hasTag("admin")) {
        player.sendMessage("§cOnly admins can create infinite shops.");
        player.playSound("note.bass");
        return;
    }

    let lockKey = null;
    
    if (!isAdminShop) {
        const chestBlock = signBlock.dimension.getBlock({x: signBlock.x, y: signBlock.y - 1, z: signBlock.z});
        if (!chestBlock || !chestBlock.getComponent("minecraft:inventory")) {
            player.sendMessage("§cShop error: No chest found directly below this sign.");
            player.playSound("note.bass");
            return;
        }

        lockKey = "shop_lock_" + chestBlock.x + "_" + chestBlock.y + "_" + chestBlock.z;
        const existingOwner = world.getDynamicProperty(lockKey);
        if (existingOwner && existingOwner !== player.name) {
            player.sendMessage("§cThis chest is already locked by " + existingOwner + ".");
            player.playSound("note.bass");
            return;
        }
    }

    try { new ItemStack(fullItemName, 1); } catch(e) {
        player.sendMessage("§cShop error: \"" + fullItemName + "\" is not a valid item.");
        player.playSound("note.bass");
        return;
    }

    const signComp = signBlock.getComponent("minecraft:sign");
    let newHeader = "";
    if (type === "shop") newHeader = "§9[Shop]";
    if (type === "sell") newHeader = "§c[Sell]";
    if (type === "adminshop") newHeader = "§5[AdminShop]";
    if (type === "adminsell") newHeader = "§5[AdminSell]";

    const niceName = toNiceName(fullItemName); 
    
    signComp.setText(newHeader + "\n§r" + amount + "\n" + price + "\n" + niceName);
    
    if (!isAdminShop) {
        world.setDynamicProperty(lockKey, player.name);
        player.sendMessage("§aSuccess! " + (type === "shop" ? "Buy" : "Sell") + " shop created and chest locked to you.");
    } else {
        player.sendMessage("§dSuccess! Infinite Admin Shop created.");
    }
    
    player.playSound("random.anvil_use");
}

function processTransaction(player, signBlock, lines, action) {
    const cleanLines = lines.map(line => line.replace(/§./g, ''));
    
    const amount = parseInt(cleanLines[1]);
    const price = parseInt(cleanLines[2]);
    const fullItemName = toIdName(cleanLines[3].trim()); 
    const niceName = toNiceName(fullItemName);
    const playerContainer = player.getComponent("minecraft:inventory").container;

    // --- ADMIN SHOP LOGIC ---
    if (action === "adminbuy") {
        const playerBalance = getBalance(player.name);
        if (playerBalance < price) {
            player.sendMessage("§cYou need $" + price + " to buy this.");
            player.playSound("note.bass");
            return;
        }
        setBalance(player.name, playerBalance - price);
        playerContainer.addItem(new ItemStack(fullItemName, amount));
        player.sendMessage("§aBought " + amount + " " + niceName + " for $" + price + ".");
        player.playSound("random.levelup");
        return;
    } 
    
    if (action === "adminsell") {
        const playerItems = countItems(playerContainer, fullItemName);
        if (playerItems < amount) {
            player.sendMessage("§cYou need " + amount + " " + niceName + " to sell.");
            player.playSound("note.bass");
            return;
        }
        removeItems(playerContainer, fullItemName, amount);
        const playerBalance = getBalance(player.name);
        setBalance(player.name, playerBalance + price);
        player.sendMessage("§aSold " + amount + " " + niceName + " for $" + price + ".");
        player.playSound("random.levelup");
        return;
    }

    // --- NORMAL SHOP LOGIC ---
    const chestBlock = signBlock.dimension.getBlock({x: signBlock.x, y: signBlock.y - 1, z: signBlock.z});
    if (!chestBlock) return;
    
    const chestInvComp = chestBlock.getComponent("minecraft:inventory");
    if (!chestInvComp) {
        player.sendMessage("§cShop error: Missing chest.");
        player.playSound("note.bass");
        return;
    }
    
    const lockKey = "shop_lock_" + chestBlock.x + "_" + chestBlock.y + "_" + chestBlock.z;
    const owner = world.getDynamicProperty(lockKey);
    if (!owner) {
        player.sendMessage("§cShop error: Cannot find the owner of this chest.");
        player.playSound("note.bass");
        return;
    }

    const chestContainer = chestInvComp.container;

    if (action === "buy") {
        const playerBalance = getBalance(player.name);
        if (playerBalance < price) {
            player.sendMessage("§cYou need $" + price + " to buy this.");
            player.playSound("note.bass");
            return;
        }
        
        const chestItems = countItems(chestContainer, fullItemName);
        if (chestItems < amount) {
            player.sendMessage("§cThis shop is out of stock!");
            player.playSound("note.bass");
            return;
        }
        
        // Transfer funds
        setBalance(player.name, playerBalance - price);
        const ownerBalance = getBalance(owner);
        setBalance(owner, ownerBalance + price);

        // Transfer items
        removeItems(chestContainer, fullItemName, amount);
        playerContainer.addItem(new ItemStack(fullItemName, amount));
        
        player.sendMessage("§aBought " + amount + " " + niceName + " for $" + price + " from " + owner + ".");
        player.playSound("random.levelup");
    } 
    else if (action === "sell") {
        const ownerBalance = getBalance(owner);
        if (ownerBalance < price) {
            player.sendMessage("§cThe shop owner (" + owner + ") does not have enough money to buy this!");
            player.playSound("note.bass");
            return;
        }

        const playerItems = countItems(playerContainer, fullItemName);
        if (playerItems < amount) {
            player.sendMessage("§cYou need " + amount + " " + niceName + " to sell.");
            player.playSound("note.bass");
            return;
        }
        
        // Transfer funds
        setBalance(owner, ownerBalance - price);
        const playerBalance = getBalance(player.name);
        setBalance(player.name, playerBalance + price);

        // Transfer items
        removeItems(playerContainer, fullItemName, amount);
        chestContainer.addItem(new ItemStack(fullItemName, amount));
        
        player.sendMessage("§aSold " + amount + " " + niceName + " to " + owner + " for $" + price + ".");
        player.playSound("random.levelup");
    }
}

function countItems(container, typeId) {
    let count = 0;
    for (let i = 0; i < container.size; i++) {
        const item = container.getItem(i);
        if (item && item.typeId === typeId) count += item.amount;
    }
    return count;
}

function removeItems(container, typeId, amount) {
    let remaining = amount;
    for (let i = 0; i < container.size; i++) {
        const item = container.getItem(i);
        if (item && item.typeId === typeId) {
            if (item.amount > remaining) {
                item.amount -= remaining;
                container.setItem(i, item);
                return;
            } else {
                remaining -= item.amount;
                container.setItem(i, undefined);
            }
            if (remaining <= 0) return;
        }
    }
}