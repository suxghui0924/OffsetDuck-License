-- Roblox Client Script (luau)
local HttpService = game:GetService("HttpService")
local UserInputService = game:GetService("UserInputService")

local API_URL = "YOUR_RAILWAY_URL" -- Change this to your Railway URL
local UserKey = "VISTA-XXXX-XXXX-XXXX" -- Usually input via UI

local function verifyLicense()
    local hwid = ""
    pcall(function()
        hwid = gethwid() -- Works on most exploits
    end)

    if hwid == "" then
        hwid = game:GetService("RbxAnalyticsService"):GetClientId() -- Fallback for testing
    end

    local roblox_id = game.Players.LocalPlayer.UserId

    print("Verifying License...")

    local success, response = pcall(function()
        return HttpService:RequestAsync({
            Url = API_URL .. "/api/verify",
            Method = "POST",
            Headers = {
                ["Content-Type"] = "application/json"
            },
            Body = HttpService:JSONEncode({
                key = UserKey,
                roblox_id = tostring(roblox_id)
            })
        })
    end)

    if not success then
        warn("API Error: " .. tostring(response))
        return
    end

    local data = HttpService:JSONDecode(response.Body)

    if data.success then
        print("Welcome! Verification Successful.")
        print("Expires At: " .. (data.expires_at or "N/A"))
        
        -- Load the actual script
        if data.script then
            loadstring(game:HttpGet(data.script))()
        end
    else
        warn("Verification Failed: " .. data.message)
        game.Players.LocalPlayer:Kick("\n[License Error]\n" .. data.message)
    end
end

-- Start Verification
verifyLicense()
