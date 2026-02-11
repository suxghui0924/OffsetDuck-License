-- Final Production Loader (client.lua)
local HttpService = game:GetService("HttpService")

local CONFIG = {
	-- Your Railway Domain
	API_URL = "https://offsetduck-license-production.up.railway.app",
	-- Your License Key (Change this or input via UI)
	SCRIPT_KEY = "VISTA-TEST-KEY-CHANGE-ME",
}

local function loadScript()
	local uid = tostring(game.Players.LocalPlayer.UserId)
	local ts = tostring(os.time())

	-- Using the 'bypass_for_test' signature for easy initial setup
	-- This allows verification to work without a complex Lua HMAC library
	local sig = "bypass_for_test"

	local url = string.format("%s/api/load?key=%s&uid=%s&ts=%s&sig=%s", CONFIG.API_URL, CONFIG.SCRIPT_KEY, uid, ts, sig)

	print("[VISTA] Connecting to server...")

	local success, response = pcall(function()
		return game:HttpGet(url)
	end)

	if not success then
		warn("[VISTA] Connection Failed!")
		return
	end

	-- Server sends error messages starting with '--'
	if response:sub(1, 2) == "--" then
		local errorMsg = response:sub(3)
		print("[VISTA] Access Denied: " .. errorMsg)
		game.Players.LocalPlayer:Kick("\n[VISTA AUTH]\n" .. errorMsg)
		return
	end

	print("[VISTA] Authentication Successful!")

	local exec_success, exec_err = pcall(function()
		loadstring(response)()
	end)

	if not exec_success then
		warn("[VISTA] Script Execution Error: " .. tostring(exec_err))
	end
end

-- Start
loadScript()
