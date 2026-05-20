/* eslint-disable max-len */
import macosVersion from "macos-version";
import CompareVersions from "compare-versions";
import { transports } from "electron-log";
import { FileSystem } from "@server/fileSystem";
import { escapeOsaExp, getiMessageAddressFormat, isEmpty, isNotEmpty } from "@server/helpers/utils";
import { isMinBigSur, isMinVentura } from "@server/env";

const osVersion = macosVersion();

const buildServiceScript = (inputService: string) => {
    // Wrap the service in quotes if we are on < macOS 11 and it's not iMessage
    let theService = inputService;
    if (!isMinBigSur && theService !== "iMessage") {
        theService = `"${theService}"`;
    }

    const svcClass = isMinVentura ? 'account' : 'service';

    let serviceScript = `set targetService to 1st ${svcClass} whose service type = ${theService}`;
    if (!isMinBigSur && theService !== "iMessage") {
        serviceScript = `set targetService to service ${theService}`;
    }

    return serviceScript;
};

const buildMessageScript = (message: string, target = "targetBuddy") => {
    let messageScpt = "";
    if (isNotEmpty(message)) {
        messageScpt = `send "${escapeOsaExp(message)}" to ${target}`;
    }

    return messageScpt;
};

const buildAttachmentScript = (attachment: string, variable = "theAttachment", target = "targetBuddy") => {
    let attachmentScpt = "";
    if (isNotEmpty(attachment)) {
        attachmentScpt = `set ${variable} to "${escapeOsaExp(attachment)}" as POSIX file
            send theAttachment to ${target}
            delay 1`;
    }

    return attachmentScpt;
};

const getAddressFromInput = (value: string) => {
    // This should always produce an array of minimum length, 1
    const valSplit = value.split(";");

    // If somehow the length is 0, just return the input
    if (isEmpty(valSplit)) return value;

    // Return the "last" index in the array (or the 0th)
    return valSplit[valSplit.length - 1];
};

const getServiceFromInput = (value: string) => {
    // This should always produce an array of minimum length, 1
    const valSplit = value.split(";");

    // If we have 0 or 1 items, it means there is no `;` character
    // so we should default to iMessage
    if (valSplit.length <= 1) return "iMessage";

    // Otherwise, return the "first" index in the array,
    return valSplit[0];
};

/**
 * Hides the Messages app
 */
export const hideMessages = () => {
    return `try
        tell application "System Events" to tell process "Messages" to set visible to false
    end try`;
};

/**
 * The AppleScript used to send a message with or without an attachment
 */
export const startMessages = () => {
    return startApp("Messages");
};

/**
 * The AppleScript used to hide an app
 */
export const hideApp = (appName: string) => {
    return `tell application "System Events" to tell application process "${appName}"
        set visible to false
    end tell`;
};

/**
 * The AppleScript used to quit an app
 */
export const quitApp = (appName: string) => {
    return `tell application "${appName}"
        quit
    end tell`;
};

/**
 * The AppleScript used to show an app
 */
export const showApp = (appName: string) => {
    return `tell application "System Events" to tell application process "${appName}"
        set frontmost to true
    end tell`;
};

// === FindMy ===

/**
 * The AppleScript used to start the FindMy app
 */
export const startFindMyFriends = () => {
    return startApp("FindMy");
};

/**
 * The AppleScript used to show the FindMy app
 */
export const showFindMyFriends = () => {
    return showApp("FindMy");
};

/**
 * The AppleScript used to quit the FindMy app
 */
export const quitFindMyFriends = () => {
    return quitApp("FindMy");
};

/**
 * The AppleScript used to hide the FindMy app
 */
export const hideFindMyFriends = () => {
    return hideApp("FindMy");
};

/**
 * The AppleScript used to start an application
 */
export const startApp = (appName: string) => {
    return `set appName to "${appName}"
        if application appName is running then
            return 0
        else
            tell application appName to reopen
        end if`;
};

/**
 * The AppleScript used to stop an application
 */
export const stopApp = (appName: string) => {
    return `set appName to "${appName}"
        if application appName is running then
            tell application appName to quit
        else
            return 0
        end if`;
};

// === Messages ===

/**
 * The AppleScript used to send a message with or without an attachment
 */
export const sendMessage = (chatGuid: string, message: string, attachment: string) => {
    if (!chatGuid || (!message && !attachment)) return null;

    // Build the sending scripts
    const attachmentScpt = buildAttachmentScript(attachment, "theAttachment", "targetChat");
    const messageScpt = buildMessageScript(message, "targetChat");

    // If it's not a GUID, throw an error
    if (!chatGuid.includes(";")) throw new Error(`Invalid GUID! Can't send message to: ${chatGuid}`);

    // If the chat is to an individual, we need to make sure the number is formatted correctly
    if (chatGuid.includes(";-;")) {
        const strSplit = chatGuid.split(";-;");
        const service = strSplit[0];
        const addr = strSplit[1];
        chatGuid = `${service};-;${getiMessageAddressFormat(addr)}`;
    }

    // Return the script
    return `tell application "Messages"
        set targetChat to a reference to chat id "${chatGuid}"

        ${attachmentScpt}
        ${messageScpt}
    end tell`;
};

export const sendMessageFallback = (chatGuid: string, message: string, attachment: string) => {
    if (!chatGuid || (!message && !attachment)) return null;

    // Build the sending scripts
    const attachmentScpt = buildAttachmentScript(attachment);
    const messageScpt = buildMessageScript(message);

    // Extract the address and service from the input address/GUID
    const address = getAddressFromInput(chatGuid);
    const service = getServiceFromInput(chatGuid);

    // If it starts with `chat`, it's a group chat, and we can't use this script for that
    if (address.startsWith("chat")) {
        throw new Error("Can't use the send message (fallback) script to text a group chat!");
    }

    // Support older OS versions with their old naming scheme
    const participant = isMinBigSur ? "participant" : "buddy";
    const serviceScript = buildServiceScript(service);
    return `tell application "Messages"
        ${serviceScript}
        set targetBuddy to ${participant} "${address}" of targetService
        
        ${attachmentScpt}
        ${messageScpt}
    end tell`;
};

/**
 * The AppleScript used to restart iMessage
 */
export const restartMessages = (delaySeconds = 3) => {
    return `tell application "Messages"
        quit
        delay ${delaySeconds}
        reopen
    end tell`;
};

/**
 * The AppleScript used to start a chat with some number of participants
 */
export const startChat = (participants: string[], service: string, message: string = null) => {
    const formatted = participants.map(buddy => `buddy "${buddy}" of targetService`);
    const buddies = formatted.join(", ");

    const messageScpt = buildMessageScript(message, "thisChat");
    const useTextChat = !isMinBigSur;
    const qualifier = useTextChat ? " text " : " ";
    const serviceScript = buildServiceScript(service);
    return `tell application "Messages"
        ${serviceScript}

        (* Start the new chat with all the recipients *)
        set thisChat to make new${qualifier}chat with properties {participants: {${buddies}}}
        log thisChat
        ${messageScpt}
    end tell

    try
        tell application "System Events" to tell process "Messages" to set visible to false
    end try`;
};

/**
 * Send an attachment on Monteray via Accessibility
 */
export const sendAttachmentAccessibility = (attachmentPath: string, participants: string[]) => {
    const recipientCommands = [];
    // Key code 125 == down arrow
    for (const i of participants) {
        recipientCommands.push(`
            delay 2
            keystroke "${i}"
            delay 1
            key code 125
            delay 1
            keystroke return`);
    }

    // The AppleScript copy _only_ works on Monterey
    const scriptCopy = `tell application "System Events" to set theFile to POSIX file "${attachmentPath}"`;
    const scriptClip = `set the clipboard to theFile`;

    // The CMD + A & Delete will clear any existing text or attachments
    return `try
            do shell script "caffeinate -u -t 1"
            delay 2
        end try
        
        ${scriptCopy ?? ""}
        tell application "System Events" to tell application process "Messages"
            set frontmost to true
            keystroke "n" using {command down}
            delay 0.5
            ${recipientCommands.join("\n")}
            delay 1
            keystroke return
            delay 0.5
            keystroke "a" using {command down}
            delay 0.5
            key code 51
            delay 0.5
            ${scriptClip ?? ""}
            delay 0.5
            keystroke "v" using {command down}
            delay 3.0
            keystroke return
        end tell`;
};

/**
 * The AppleScript used to rename a group chat
 */
export const openChat = (name: string) => {
    return `tell application "System Events"
        (* Check if messages was in the foreground *)
        set isForeground to false
        tell application "Finder"
            try
                set frontApp to window 1 of (first application process whose frontmost is true)
                set winName to name of frontApp
                if winName is equal to "Messages" then
                    set isForeground to true
                end if
            end try
        end tell

        tell process "Messages"
            set groupMatch to -1
            
            (* Iterate over each chat row *)
            repeat with chatRow in ((table 1 of scroll area 1 of splitter group 1 of window 1)'s entire contents as list)
                if chatRow's class is row then
                    
                    (* Pull out the chat's name *)
                    set fullName to (chatRow's UI element 1)'s description
                    set nameSplit to my splitText(fullName, ". ")
                    set chatName to item 1 of nameSplit
                    
                    (* Only pull out groups *)
                    if chatName is equal to "${name}" then
                        set groupMatch to chatRow
                        exit repeat
                    end if
                end if
            end repeat
            
            (* If no match, exit *)
            if groupMatch is equal to -1 then
                tell me to error "Group chat does not exist"
            end if

            (* We have to activate the window so that we can hit enter *)
            tell application "Messages"
                reopen
                activate
            end tell
            delay 1
            
            (* Select the chat *)
            select groupMatch

        (* If the window was not in the foreground originally, hide it *)
        try
            if isForeground is equal to false then
                tell application "Finder"
                    set visible of process "Messages" to false
                end tell
            end if
        on error errorMsg
            (* Don't do anything *)
        end try
    end tell

    on splitText(theText, theDelimiter)
        set AppleScript's text item delimiters to theDelimiter
        set theTextItems to every text item of theText
        set AppleScript's text item delimiters to ""
        return theTextItems
    end splitText`;
};

/**
 * The AppleScript used to rename a group chat
 */
export const renameGroupChat = (currentName: string, newName: string) => {
    return `tell application "System Events"
        (* Check if messages was in the foreground *)
        set isForeground to false
        tell application "Finder"
            try
                set frontApp to window 1 of (first application process whose frontmost is true)
                set winName to name of frontApp
                if winName is equal to "Messages" then
                    set isForeground to true
                end if
            end try
        end tell

        tell process "Messages"
            set groupMatch to -1
            
            (* Iterate over each chat row *)
            repeat with chatRow in ((table 1 of scroll area 1 of splitter group 1 of window 1)'s entire contents as list)
                if chatRow's class is row then
                    
                    (* Pull out the chat's name *)
                    set fullName to (chatRow's UI element 1)'s description
                    set nameSplit to my splitText(fullName, ". ")
                    set chatName to item 1 of nameSplit
                    
                    (* Only pull out groups *)
                    if chatName is equal to "${currentName}" then
                        set groupMatch to chatRow
                        exit repeat
                    end if
                end if
            end repeat
            
            (* If no match, exit *)
            if groupMatch is equal to -1 then
                tell me to error "Group chat does not exist"
            end if

            (* We have to activate the window so that we can hit enter *)
            tell application "Messages"
                reopen
                activate
            end tell
            delay 1
            
            (* Select the chat and rename it *)
            select groupMatch
            try
                tell window 1 to tell splitter group 1 to tell button "Details"
                    try
                        (* If the popover is open, don't re-click Details *)
                        set popover to pop over 1
                    on error notOpen
                        (* If the popover is not open, click Details *)
                        click
                    end try

                    tell pop over 1 to tell scroll area 1 to tell text field 1
                        set value to "${newName}"
                        confirm
                    end tell
                    click
                end tell
            on error errorMessage
                tell me to error "execution error: Failed to rename group -> " & errorMessage
                key code 53
            end try
        end tell

        (* If the window was not in the foreground originally, hide it *)
        try
            if isForeground is equal to false then
                tell application "Finder"
                    set visible of process "Messages" to false
                end tell
            end if
        on error errorMsg
            (* Don't do anything *)
        end try
    end tell

    on splitText(theText, theDelimiter)
        set AppleScript's text item delimiters to theDelimiter
        set theTextItems to every text item of theText
        set AppleScript's text item delimiters to ""
        return theTextItems
    end splitText`;
};

/**
 * AppleScript to add a participant to a group
 */
export const addParticipant = (currentName: string, participant: string) => {
    return `tell application "System Events"
        (* Check if messages was in the foreground *)
        set isForeground to false
        tell application "Finder"
            try
                set frontApp to window 1 of (first application process whose frontmost is true)
                set winName to name of frontApp
                if winName is equal to "Messages" then
                    set isForeground to true
                end if
            end try
        end tell

        tell process "Messages"
            set groupMatch to -1
            
            (* Iterate over each chat row *)
            repeat with chatRow in ((table 1 of scroll area 1 of splitter group 1 of window 1)'s entire contents as list)
                if chatRow's class is row then
                    
                    (* Pull out the chat's name *)
                    set fullName to (chatRow's UI element 1)'s description
                    set nameSplit to my splitText(fullName, ". ")
                    set chatName to item 1 of nameSplit
                    
                    (* Only pull out groups *)
                    if chatName is equal to "${currentName}" then
                        set groupMatch to chatRow
                        exit repeat
                    end if
                end if
            end repeat
            
            if groupMatch is equal to -1 then
                tell me to error "Group chat does not exist"
            end if

            (* We have to activate the window so that we can hit enter *)
            tell application "Messages"
                reopen
                activate
            end tell
            delay 1
            
            select groupMatch
            try
                tell window 1 to tell splitter group 1 to tell button "Details"
                    try
                        (* If the popover is open, don't re-click Details *)
                        set popover to pop over 1
                    on error notOpen
                        (* If the popover is not open, click Details *)
                        click
                    end try

                    tell pop over 1 to tell scroll area 1 to tell text field 2
                        set value to "${participant}"
                        set focused to true
                        key code 36 -- Enter
                    end tell
                end tell
                
                delay 1
                set totalWindows to count windows
                
                if totalWindows is greater than 1 then
                    repeat (totalWindows - 1) times
                        try
                            tell button 1 of window 1 to perform action "AXPress"
                        on error
                            exit repeat
                        end try
                    end repeat
                    log "Error: Not an iMessage address"
                    return
                end if
            on error errorMessage
                log errorMessage
                return
            end try
            
            key code 53 -- Escape
            log "success"
        end tell

        (* If the window was not in the foreground originally, hide it *)
        try
            if isForeground is equal to false then
                tell application "Finder"
                    set visible of process "Messages" to false
                end tell
            end if
        on error errorMsg
            (* Don't do anything *)
        end try
    end tell

    on splitText(theText, theDelimiter)
        set AppleScript's text item delimiters to theDelimiter
        set theTextItems to every text item of theText
        set AppleScript's text item delimiters to ""
        return theTextItems
    end splitText`;
};

/**
 * AppleScript to add a participant to a group
 */
export const removeParticipant = (currentName: string, address: string) => {
    return `tell application "System Events"
        (* Check if messages was in the foreground *)
        set isForeground to false
        tell application "Finder"
            try
                set frontApp to window 1 of (first application process whose frontmost is true)
                set winName to name of frontApp
                if winName is equal to "Messages" then
                    set isForeground to true
                end if
            end try
        end tell

        tell process "Messages"
            set groupMatch to -1
            
            (* Iterate over each chat row *)
            repeat with chatRow in ((table 1 of scroll area 1 of splitter group 1 of window 1)'s entire contents as list)
                if chatRow's class is row then
                    
                    (* Pull out the chat's name *)
                    set fullName to (chatRow's UI element 1)'s description
                    set nameSplit to my splitText(fullName, ". ")
                    set chatName to item 1 of nameSplit
                    
                    (* Only pull out groups *)
                    if chatName is equal to "${currentName}" then
                        set groupMatch to chatRow
                        exit repeat
                    end if
                end if
            end repeat
            
            if groupMatch is equal to -1 then
                tell me to error "Group chat does not exist"
            end if

            (* We have to activate the window so that we can hit enter *)
            tell application "Messages"
                reopen
                activate
            end tell
            delay 1
            
            select groupMatch
            try
                tell window 1 to tell splitter group 1 to tell button "Details"
                    try
                        (* If the popover is open, don't re-click Details *)
                        set popover to pop over 1
                    on error notOpen
                        (* If the popover is not open, click Details *)
                        click
                    end try

                    tell pop over 1 to tell scroll area 1
                        set contactRow to -1
                        repeat with participant in (table 1's entire contents) as list
                            if participant's class is row then
                                if name of participant's UI element 1 is equal to "${address}" then
                                    set contactRow to participant
                                    exit repeat
                                end if
                            end if
                        end repeat
                        
                        if contactRow is equal to -1 then
                            key code 53
                            log "Error: Address is not a participant"
                            return
                        end if
                        
                        select contactRow
                        delay 0.1
                        key code 51
                        delay 0.3
                        key code 53
                    end tell
                end tell

            on error errorMessage
                log errorMessage
            end try
        
            log "success"
        end tell

        (* If the window was not in the foreground originally, hide it *)
        try
            if isForeground is equal to false then
                tell application "Finder"
                    set visible of process "Messages" to false
                end tell
            end if
        on error errorMsg
            (* Don't do anything *)
        end try
    end tell

    on splitText(theText, theDelimiter)
        set AppleScript's text item delimiters to theDelimiter
        set theTextItems to every text item of theText
        set AppleScript's text item delimiters to ""
        return theTextItems
    end splitText`;
};

/**
 * AppleScript to send a tap-back
 */
export const toggleTapback = (chatName: string, messageText: string, reactionIndex: number) => {
    return `tell application "System Events"
        tell process "Messages"
            set groupMatch to -1
            
            (* Iterate over each chat row *)
            repeat with chatRow in ((table 1 of scroll area 1 of splitter group 1 of window 1)'s entire contents as list)
                if chatRow's class is row then
                    
                    (* Pull out the chat's name *)
                    set fullName to (chatRow's UI element 1)'s description
                    set nameSplit to my splitText(fullName, ". ")
                    set chatName to item 1 of nameSplit
                    
                    (* Only pull out groups *)
                    if chatName is equal to "${chatName}" then
                        set groupMatch to chatRow
                        exit repeat
                    end if
                end if
            end repeat
            
            (* If no match, exit *)
            if groupMatch is equal to -1 then
                tell me to error "Group chat does not exist"
            end if
            
            (* We have to activate the window so that we can hit enter *)
            tell application "Messages"
                reopen
                activate
            end tell
            delay 1
            
            (* Select the chat and rename it *)
            select groupMatch
            tell window 1 to tell splitter group 1
                set previousRow to null
                (* Get the text messages as a list and reverse it to get newest first *)
                set chatItems to reverse of (entire contents of scroll area 2 as list)
                
                (* Iterate over all the messages *)
                repeat with n from 1 to count of chatItems
                    set chatRow to (item n of chatItems)
                    
                    (* Check the types of the current row and previous row *)
                    if chatRow's class is static text and previousRow's class is group then
                        set textValue to chatRow's value
                        log textValue
                        (* Compare the text with what we are looking for *)
                        if textValue is equal to "${messageText}" then
                            select chatRow
                            tell previousRow to perform action "AXShowMenu"
                            delay 0.5
                            key code 125
                            keystroke return
                            delay 2.0
                            
                            (* Re-fetch the rows so we can get the tapback row *)
                            set newRows to reverse of (entire contents of scroll area 2 as list)
                            set tapBack to item (n + 1) of newRows
                            if tapBack's class is not radio group then
                                set tapBack to item (n - 1) of newRows
                            end if
                            tell radio button (${reactionIndex} as number) of tapBack to perform action "AXPress"
                            delay 0.5
                            keystroke return
                            
                            return
                        end if
                    end if
                    
                    set previousRow to chatRow
                end repeat
            end tell
        end tell
    end tell

    on splitText(theText, theDelimiter)
        set AppleScript's text item delimiters to theDelimiter
        set theTextItems to every text item of theText
        set AppleScript's text item delimiters to ""
        return theTextItems
    end splitText`;
};

/**
 * Checks if a typing indicator is present
 */
export const checkTypingIndicator = (chatName: string) => {
    return `tell application "System Events"
        set isTyping to false
        tell process "Messages"
            set groupMatch to -1
            
            (* Iterate over each chat row *)
            repeat with chatRow in ((table 1 of scroll area 1 of splitter group 1 of window 1)'s entire contents as list)
                if chatRow's class is row then
                    
                    (* Pull out the chat's name *)
                    set fullName to (chatRow's UI element 1)'s description
                    set nameSplit to my splitText(fullName, ". ")
                    set chatName to item 1 of nameSplit
                    
                    (* Only pull out groups *)
                    if chatName is equal to "${chatName}" then
                        set groupMatch to chatRow
                        exit repeat
                    end if
                end if
            end repeat
            
            (* If no match, exit *)
            if groupMatch is equal to -1 then
                tell me to error "Group chat does not exist"
            end if
            
            (* Select the chat and rename it *)
            select groupMatch
            tell window 1 to tell splitter group 1
                set previousRow to null
                (* Get the text messages as a list and reverse it to get newest first *)
                set chatItems to reverse of (entire contents of scroll area 2 as list)
                
                (* Check the 7th item. If it's an image, then it's the typing indicator *)
                set typingEl to (item 7 of chatItems)
                if typingEl's class is image then
                    set isTyping to true
                end if
            end tell
        end tell
        
        (* Return true/false *)
        log isTyping
    end tell

    on splitText(theText, theDelimiter)
        set AppleScript's text item delimiters to theDelimiter
        set theTextItems to every text item of theText
        set AppleScript's text item delimiters to ""
        return theTextItems
    end splitText`;
};

// === Contacts ===

/**
 * Export contacts to a VCF file
 */
export const exportContacts = () => {
    let contactsApp = "Contacts";
    // If the OS Version is earlier than or equal to 10.7.0, use "Address Book"
    if (osVersion && CompareVersions(osVersion, "10.7.0") <= 0) contactsApp = "Address Book";

    return `set contactsPath to POSIX file "${FileSystem.contactsDir}/AddressBook.vcf" as string
        tell application "${contactsApp}"
            quit
            delay 1.0
            reopen

            (* Create empty file *)
            set contactsFile to (open for access file contactsPath with write permission)

            try
                (* Add VCF contacts to file *)
                repeat with per in people
                    write ((vcard of per as text) & linefeed) to contactsFile
                end repeat

                (* Close the file *)
                close access contactsFile
            on error
                try
                    close access contactsFile
                on error
                    log "Failed to close contacts file"
                end try
            end try
        end tell`;
};

// === System ===

export const runTerminalScript = (path: string) => {
    return `tell application "Terminal" to do script "${escapeOsaExp(path)}"`;
};

export const openSystemPreferences = () => {
    return `tell application "System Preferences"
        reopen
        activate
    end tell`;
};

export const openFilePath = (filePath: string) => {
    filePath = filePath.replace(/ /g, "\\ ");
    return `do shell script "open ${escapeOsaExp(filePath)}"`;
};

export const openLogs = () => {
    const logPath = transports.file.getFile().path;
    const pieces = logPath.split("/");
    const parent = pieces.slice(0, pieces.length - 1).join("/");
    return openFilePath(parent);
};

export const openAppData = () => {
    const parent = FileSystem.baseDir;
    return openFilePath(parent);
};

export const checkForIncomingFacetime11 = () => {
    return `tell application "System Events"
        if not (exists group 1 of UI element 1 of scroll area 1 of window 1 of application process "NotificationCenter") then
            return ""
        end if
        
        set notificationGroup to group 1 of UI element 1 of scroll area 1 of window 1 of application process "NotificationCenter"
        try
            if (exists static text 1 of notificationGroup) and (exists static text 2 of notificationGroup) and (value of static text 1 of notificationGroup starts with "FaceTime") then
                return value of static text 2 of notificationGroup
            else
                return ""
            end if
        on error
            return ""
        end try
    end tell`;
};

export const checkForIncomingFacetime13 = () => {
    return `tell application "System Events"
        if not (exists group 1 of UI element 1 of scroll area 1 of group 1 of window 1 of application process "NotificationCenter") then
            return ""
        end if
        
        set notificationGroup to group 1 of UI element 1 of scroll area 1 of group 1 of window 1 of application process "NotificationCenter"
        
        try
            if (exists static text 1 of notificationGroup) and (exists static text 2 of notificationGroup) then
                set callType to value of static text 1 of notificationGroup
                if not (callType starts with "FaceTime") then
                    return ""
                end if

                return value of static text 2 of notificationGroup
            end if
        on error
            return ""
        end try
        
        return ""
    end tell`;
};

export const checkForIncomingFacetime10 = () => {
    return `tell application "System Events"
        tell application process "NotificationCenter"
            if not (exists static text 1 of window 1) or not (exists static text 2 of window 1) then
                return ""
            end if
            
            try
                if (value of static text 1 of window 1 starts with "FaceTime") then
                    return value of static text 2 of window 1
                else
                    return ""
                end if
            on error
                return ""
            end try
        end tell
    end tell`;
};
