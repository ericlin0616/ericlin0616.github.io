/**
 * NicoPark 入園登記 + 店家後台｜Google Apps Script
 *
 * 公開端：
 *   sendOtp / submit / lookup / prefill
 * 店家後台：
 *   adminLogin / adminLogout / adminSnapshot / adminDashboard / adminListCases
 *   adminGetCase / adminUpdateCase / adminFindCustomers
 * 試算表：
 *   入園登記 / 業主總覽 / 管理稽核
 *
 * 第一次設定：
 *  1. Apps Script「專案設定 → 指令碼屬性」加入：
 *     BUSINESS_EMAIL       店家收件信箱
 *     ADMIN_USERNAME       後台帳號，例如 nico
 *     ADMIN_INITIAL_PASSWORD  一次性初始密碼（建議 14 碼以上）
 *     （驗證碼固定寄至電子信箱；不使用手機簡訊或三竹帳號）
 *  2. 在編輯器手動執行 initializeNicoPark() 並完成 Google 授權。
 *  3. 初始化會建立資料夾、試算表、稽核表，將密碼轉成加鹽雜湊後刪除明碼。
 *  4. 部署為網頁應用程式：執行身分「我」、存取權「任何人」。
 *
 * 注意：後台密碼、雜湊、管理 Session 都只存在 GAS 端，不得放進 HTML。
 */

var CONFIG = {
  FOLDER_ID: "",
  SHEET_ID: "",
  SHEET_NAME: "入園登記",
  AUDIT_SHEET_NAME: "管理稽核",
  OVERVIEW_SHEET_NAME: "業主總覽",
  BUSINESS_NAME: "Nico Nico Pet House 尼口尼口寵物精緻美容旅館",
  BUSINESS_EMAIL: "",
  OTP_TTL_SEC: 600,
  OTP_MAX_TRIES: 5,
  OTP_RESEND_SEC: 60,
  OTP_HOUR_CAP: 25,
  ADMIN_SESSION_SEC: 14400,
  ADMIN_LOGIN_MAX_FAILS: 5,
  ADMIN_LOGIN_BLOCK_SEC: 900,
  SEND_MAIL: true,
  ATTACH_PDF: true,
  MAIL_HOUR_CAP: 40,
  TERMS_VERSION: "NP-2026-09-08-v3-email",
  MAX_CASES_PER_QUERY: 200
};

// PDF 採用中性奶茶／石灰色，不使用粉色欄位底色。
var PDF_PALETTE = {
  title: "#DED7CD",
  label: "#E8E2D8",
  cell: "#FFFDFC",
  border: "#CFC6BA",
  text: "#4A372D",
  bar: "#53453A",
  barText: "#F8F3EC",
  alert: "#597064",
  alertSoft: "#EDF3ED"
};

var SHEET_HEADERS = [
  "案件識別碼", "送出時間", "客戶編號", "飼主名稱", "聯絡電話", "電子信箱", "LINE名稱",
  "緊急聯絡人", "緊急聯絡人電話", "毛寶名字", "性別", "品種", "年齡", "體重kg",
  "是否結紮", "是否發情", "親狗親人", "護食護玩具", "牽繩狀況", "固定獸醫院",
  "獸醫院名稱與電話", "近14天健康", "疾病紀錄", "驅蟲時間", "滴劑口服藥",
  "注意事項", "OTP驗證結果", "條款版本號", "已同意條款", "簽署時間",
  "雲端資料夾", "PDF連結", "簽名檔", "客戶端裝置資訊",
  "案件狀態", "店家備註", "最後更新時間", "最後更新人員"
];

var AUDIT_HEADERS = ["時間", "管理員", "操作", "目標", "內容"];
var CASE_STATUSES = ["待審核", "待聯繫", "已確認", "已完成", "已取消"];

var TERMS_SECTIONS = [
  {
    title: "一、資料真實與風險告知",
    items: [
      "飼主保證本表所填寫之飼主與毛孩資料均為真實、完整且最新。若因資料不實、缺漏或隱匿，導致毛孩、其他動物、人員或環境受有損害，飼主同意負擔相關責任。",
      "寵物美容、旅館住宿與園區活動本質上存在一定風險，包含但不限於緊迫、抓傷、咬傷、皮膚敏感、舊疾誘發或個別體質反應。本館將盡善良管理人之注意義務，惟無法保證完全零風險。",
      "飼主應於入園前主動告知護食、護玩具、敏感部位、恐懼或攻擊傾向、傳染性疾病疑慮及其他照護注意事項，以便本館安排合適的照顧方式。"
    ]
  },
  {
    title: "二、入園評估與服務調整",
    items: [
      "本館保有入園評估之權利。若現場觀察發現毛孩之健康、情緒、攻擊性、傳染疑慮或其他狀況不適於當日服務或與其他毛孩互動，本館得調整服務內容、改採隔離或單獨照護、暫停活動，或視情況拒絕、中止當日入園，並將盡速通知飼主。",
      "美容、旅館與 NicoPark 活動之實際進行方式，得依毛孩當下狀態、天候、園區安全及現場人力作必要調整。",
      "本表為入園資料與風險同意之紀錄，並非特定服務結果之保證。"
    ]
  },
  {
    title: "三、健康與緊急醫療",
    items: [
      "近十四日若有咳嗽、嘔吐、腹瀉、精神或食慾不佳、皮膚病灶、寄生蟲、傷口、術後恢復或其他異常情形，應據實勾選。本館得要求提供獸醫證明，或建議延後入園。",
      "入園期間如發現毛孩有緊急不適、創傷、傳染病疑慮或其他需立即處理之狀況，飼主同意本館得聯繫本人或指定之緊急聯絡人，並得送至填寫之固定獸醫院；若無法及時取得聯繫或未指定醫院，本館得送至就近合格動物醫療機構進行必要處置。",
      "因此產生之醫療、交通及其他合理費用，由飼主負擔。本館將在合理範圍內盡速通知。",
      "本館並非醫療機構，無法取代獸醫師之診斷或治療。"
    ]
  },
  {
    title: "四、戶外活動風險",
    items: [
      "NicoPark 及相關戶外或半戶外活動，可能涉及與其他毛孩、人員及環境刺激之接觸。即使採取分組、牽繩、隔離或現場引導，仍可能發生追逐、吠叫、擦撞、緊迫或情緒反應。",
      "本館得依毛孩之牽繩狀況、社交性格與當日狀態，決定是否安排戶外活動、活動強度，以及是否改為室內或單獨照護。",
      "飼主不得要求本館違反安全判斷進行活動。"
    ]
  },
  {
    title: "五、毛孩影像拍攝與使用同意",
    items: [
      "本條為飼主就毛孩影像之拍攝與使用所為之授權，不包含飼主本人之肖像使用授權。飼主應於簽署前另行閱讀並勾選本條同意選項。",
      "經飼主同意，本館得於寵物美容、旅館住宿及 NicoPark 活動期間拍攝毛孩照片或影片，並於照護紀錄、本館官方網站、Facebook、Instagram、LINE 及店內展示範圍內使用。",
      "本授權不包含以飼主臉部或本人影像為主體進行拍攝或宣傳；如需使用可辨識飼主本人之影像作為宣傳素材，本館應另行取得本人同意。",
      "本館不得將毛孩照片或影片出售予與本服務無關之第三人，亦不得逾越本條約定之使用範圍。",
      "飼主得於事後向本館提出停止使用特定影像或移除特定貼文之要求。本館將於可控制之官方管道配合處理；惟對於已公開且遭第三人轉載、下載或保存之內容，無法保證全數收回或刪除。"
    ]
  },
  {
    title: "六、電子文件與證據紀錄",
    items: [
      "飼主同意以電子文件、網頁表單與手寫電子簽章完成本次入園資料之簽署，其效力與紙本簽章相同。",
      "飼主同意本館得保存本表內容、簽署時間、客戶端裝置資訊、簽名圖檔及電子信箱驗證紀錄，作為服務聯繫、爭議釐清與法令遵循之證據。",
      "案件識別碼與文件副本由本館系統產製並提供，飼主應自行妥善保存。"
    ]
  },
  {
    title: "七、個人資料蒐集告知",
    items: [
      "蒐集者：Nico Nico Pet House 尼口尼口寵物精緻美容旅館。",
      "蒐集目的：毛孩入園評估與照護、客戶聯繫、緊急醫療聯繫、服務品質管理、客訴與帳務處理、法令遵循及爭議處理。",
      "蒐集項目：飼主姓名、聯絡電話、電子信箱、LINE 名稱、緊急聯絡資料、毛孩基本資料與健康照護資訊、簽名圖檔、驗證紀錄及客戶端裝置資訊。",
      "利用期間：服務期間及結束後，依法令或為主張或防禦權利所必要之合理保存期間。",
      "利用地區：臺灣地區，以及為提供電子郵件、雲端備份所必要之處理地。",
      "利用對象：本館負責人及受託處理事務之人員、緊急醫療機構、依法有權機關。",
      "利用方式：以電子或紙本方式為儲存、比對、傳遞與聯繫。",
      "飼主得依個人資料保護法向本館查詢、請求閱覽、製給複製本、補充更正、請求停止蒐集處理利用或刪除。惟依法或為履行契約所必要之資料，本館得拒絕刪除。",
      "若不提供必要資料，或未完成條款同意、手寫簽署與驗證，本館將無法完成入園登記。"
    ]
  }
];

var OPTIONS = {
  gender: ["男生", "女生"],
  yesNo: ["是", "否"],
  sociability: ["親狗親人", "親狗不親人", "親人不親狗", "皆不親"],
  guarding: ["有護食、護玩具", "突然被觸碰敏感部位會低吼", "無此狀況", "其他"],
  leash: ["乖巧隨行", "會微微拉緊", "看到人車或貓狗會激動暴衝"],
  health14: ["咳嗽", "嘔吐", "腹瀉", "食慾不佳", "精神不佳", "發燒", "皮膚紅疹", "掉毛異常", "黴菌／皮膚病疑慮", "跳蚤／壁蝨", "傷口", "術後恢復中", "以上皆無"],
  diseases: ["心臟病", "氣管塌陷", "癲癇", "關節問題", "呼吸道疾病", "過敏", "皮膚病", "其他疾病", "以上皆無"],
  deworm: ["半年內", "一年", "不太確定", "其他"],
  preventative: ["是", "否", "其他"]
};

function doGet() {
  return json_({
    ok: true,
    service: "NicoPark",
    version: "2026-09-email-otp-v2",
    message: "NicoPark 入園登記服務運作中"
  });
}

function doPost(e) {
  try {
    var payload = parsePayload_(e);
    var action = text_(payload.action, 40);

    if (action === "sendOtp") return json_(sendOtp_(payload));
    if (action === "submit") return json_(submit_(payload));
    if (action === "lookup") return json_(lookup_(payload));
    if (action === "prefill") return json_(prefill_(payload));

    if (action === "adminLogin") return json_(adminLogin_(payload));
    if (action === "adminLogout") return json_(adminLogout_(payload));
    if (action === "adminSnapshot") return json_(adminSnapshot_(payload));
    if (action === "adminDashboard") return json_(adminDashboard_(payload));
    if (action === "adminListCases") return json_(adminListCases_(payload));
    if (action === "adminGetCase") return json_(adminGetCase_(payload));
    if (action === "adminUpdateCase") return json_(adminUpdateCase_(payload));
    if (action === "adminFindCustomers") return json_(adminFindCustomers_(payload));

    return json_({ success: false, status: "error", message: "未知的操作，請重新整理頁面後再試。" });
  } catch (err) {
    return json_({ success: false, status: "error", message: friendlyErr_(err) });
  }
}

/**
 * 第一次部署前手動執行。此函式不透過 Web API 開放。
 */
function initializeNicoPark() {
  var sh = getSheet_();
  getAuditSheet_();
  var overview = getOwnerOverviewSheet_();
  var adminReady = initializeAdminPassword_();
  var migrated = backfillCustomerIds_();
  refreshOwnerOverview_();
  var editTriggerReady = ensureOwnerOverviewEditTrigger_();
  var result = {
    sheetUrl: sh.getParent().getUrl(),
    overviewUrl: spreadsheetSheetUrl_(overview),
    folderUrl: getRootFolder_().getUrl(),
    adminReady: adminReady,
    customerIdsAdded: migrated,
    editTriggerReady: editTriggerReady
  };
  Logger.log(JSON.stringify(result));
  return result;
}

/**
 * 舊資料補客戶編號，可由店家在 Apps Script 編輯器再次手動執行。
 */
function backfillCustomerIds() {
  var count = backfillCustomerIds_();
  Logger.log("已補上 " + count + " 列客戶編號");
  return count;
}

function sendOtp_(payload) {
  var email = normalizeEmail_(payload.email);
  var purpose = text_(payload.purpose || "submit", 20);
  var customerId = normalizeCustomerId_(payload.customerId);
  if (!email) throw new Error("電子信箱格式不正確，請返回第一步確認。");
  if (["submit", "lookup", "prefill"].indexOf(purpose) < 0) throw new Error("驗證用途不正確。");

  if (purpose === "lookup") {
    if (!findLatestEmail_(email)) {
      throw new Error("找不到此電子信箱的入園紀錄，請確認信箱或先完成登記。");
    }
  } else if (purpose === "prefill") {
    if (!customerId) throw new Error("請輸入正確的客戶編號。");
    if (!findCustomerIdentityByEmail_(customerId, email)) {
      throw new Error("客戶編號與登記電子信箱不相符，請重新確認。");
    }
  }

  var cache = CacheService.getScriptCache();
  var resendKey = "otp_sent_" + purpose + "_" + digestText_(email + "|" + customerId).slice(0, 24);
  if (cache.get(resendKey)) throw new Error("請稍候再重新發送驗證碼。");
  if (hourCount_("otp") >= CONFIG.OTP_HOUR_CAP) {
    throw new Error("目前驗證信件發送次數已達上限，請一小時後再試。");
  }

  var code = randomDigits_(6);
  var nonce = randomToken_();
  var rec = {
    hash: otpDigest_(email, purpose, customerId, code, nonce),
    nonce: nonce,
    purpose: purpose,
    customerId: customerId,
    channel: "email",
    email: email,
    exp: Date.now() + CONFIG.OTP_TTL_SEC * 1000,
    tries: 0
  };

  sendMailSafe_({
    to: email,
    subject: "NicoPark 入園驗證碼",
    name: "Nico Nico Pet House",
    body:
      "您好，\n\n" +
      "您的 NicoPark 驗證碼：" + code + "\n" +
      "請於 10 分鐘內輸入。若不是您本人操作，請忽略此信。\n\n" +
      CONFIG.BUSINESS_NAME + "\n"
  });
  cache.put(otpKey_(email, purpose, customerId), JSON.stringify(rec), CONFIG.OTP_TTL_SEC);
  cache.put(resendKey, "1", CONFIG.OTP_RESEND_SEC);
  bumpHour_("otp");

  return {
    success: true,
    status: "success",
    channel: "email",
    destination: maskEmail_(email),
    emailMasked: maskEmail_(email),
    phoneMasked: "",
    message: "驗證碼已寄到 " + maskEmail_(email)
  };
}

function submit_(payload) {
  var form = payload.form || {};
  var owner = form.owner || {};
  var list = petsOf_(form);
  validateSubmission_(owner, list, payload);

  var phone = normalizePhone_(owner.phone);
  var email = normalizeEmail_(owner.email);
  var otpRecord = verifyOtp_(email, text_(payload.otp, 10), "submit", "");
  if (normalizeEmail_(otpRecord.email) !== email) {
    throw new Error("驗證信箱與填寫資料不相符，請重新發送驗證碼。");
  }
  payload.otpChannel = otpRecord.channel || "email";

  var requestId = text_(payload.requestId, 80);
  var requestKey = requestId ? "submit_" + digestText_(requestId).slice(0, 36) : "";
  var cache = CacheService.getScriptCache();
  var previous = requestKey ? cache.get(requestKey) : "";
  if (previous) {
    try {
      var priorResult = JSON.parse(previous);
      if (priorResult && priorResult.caseId) return priorResult;
    } catch (ignorePrevious) {}
    throw new Error("此筆資料正在處理，請稍候再使用案件查詢確認，勿重複送出。");
  }
  if (requestKey) cache.put(requestKey, "processing", 600);

  var caseId = makeCaseId_();
  var now = new Date();
  var tzNow = Utilities.formatDate(now, "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
  var customerId = findOrCreateCustomerId_(phone, email);
  var names = list.map(function (x) { return x.pet && x.pet.name; }).filter(function (n) { return n; });
  var folderLabel = names.length > 1
    ? safeName_(names[0]) + "等" + names.length + "隻"
    : safeName_(names[0] || "毛孩");

  try {
    var root = getRootFolder_();
    var caseFolder = root.createFolder(caseId + "_" + folderLabel + "_" + Utilities.formatDate(now, "Asia/Taipei", "yyyyMMdd"));
    var signBlob = dataUrlToBlob_(payload.signatureDataUrl, caseId + "_簽名.png");
    var signFile = caseFolder.createFile(signBlob);
    var pdfFile = createPdf_(caseFolder, caseId, customerId, tzNow, owner, list, payload, signBlob);

    try { pdfFile.addViewer(email); } catch (e1) {}
    try { signFile.addViewer(email); } catch (e2) {}

    withScriptLock_(function () {
      list.forEach(function (item) {
        appendRecordRow_({
          caseId: caseId,
          submittedAt: tzNow,
          customerId: customerId,
          owner: owner,
          pet: item.pet,
          care: item.care,
          payload: payload,
          folderUrl: caseFolder.getUrl(),
          pdfUrl: pdfFile.getUrl(),
          signUrl: signFile.getUrl()
        });
      });
      try { refreshOwnerOverview_(); } catch (overviewErr) {}
    });

    var customerMailed = false;
    var businessMailed = false;
    try {
      sendCustomerMail_(owner, names, caseId, customerId, pdfFile);
      customerMailed = true;
    } catch (mailErr1) {}
    try {
      var businessEmail = getBusinessEmail_();
      if (businessEmail) {
        sendBusinessMail_(businessEmail, owner, names, caseId, customerId, pdfFile, caseFolder.getUrl());
        businessMailed = true;
      }
    } catch (mailErr2) {}

    consumeOtp_(email, "submit", "");
    var result = {
      success: true,
      status: "success",
      caseId: caseId,
      customerId: customerId,
      pdfUrl: pdfFile.getUrl(),
      message: customerMailed
        ? "入園資料已送出，案件副本已寄到 " + email + "。"
        : "入園資料與 PDF 已完成存檔；目前 Google 寄信暫時受限，請保留案件識別碼。"
    };
    if (requestKey) cache.put(requestKey, JSON.stringify(result), 21600);
    return result;
  } catch (err) {
    if (requestKey) cache.remove(requestKey);
    throw err;
  }
}

function lookup_(payload) {
  var email = normalizeEmail_(payload.email);
  if (!email) throw new Error("電子信箱格式不正確。");
  var rec = verifyOtp_(email, text_(payload.otp, 10), "lookup", "");
  var rows = getRecordRows_();
  var byId = {};
  var order = [];

  for (var i = rows.length - 1; i >= 0; i--) {
    var row = rows[i];
    if (normalizeEmail_(row["電子信箱"]) !== normalizeEmail_(rec.email)) continue;
    var id = row["案件識別碼"];
    if (!id) continue;
    if (!byId[id]) {
      byId[id] = {
        caseId: id,
        customerId: row["客戶編號"] || "",
        submittedAt: row["送出時間"] || "",
        petNames: [],
        pdfUrl: row["PDF連結"] || "",
        status: row["案件狀態"] || "待審核"
      };
      order.push(id);
    }
    uniquePush_(byId[id].petNames, row["毛寶名字"]);
  }
  consumeOtp_(email, "lookup", "");
  return {
    success: true,
    status: "success",
    cases: order.slice(0, 30).map(function (id) { return byId[id]; })
  };
}

function prefill_(payload) {
  var email = normalizeEmail_(payload.email);
  var customerId = normalizeCustomerId_(payload.customerId);
  if (!email || !customerId) throw new Error("請輸入客戶編號與登記電子信箱。");
  verifyOtp_(email, text_(payload.otp, 10), "prefill", customerId);
  var profile = buildCustomerProfile_(customerId, email);
  if (!profile) throw new Error("找不到可帶入的舊客資料。");
  consumeOtp_(email, "prefill", customerId);
  audit_("customer", "PUBLIC_PREFILL", customerId, "已驗證電子信箱 " + maskEmail_(email));
  return {
    success: true,
    status: "success",
    profile: profile,
    message: "已帶入上次的聯絡與毛孩資料；近 14 天健康狀況仍須重新確認。"
  };
}

function adminLogin_(payload) {
  var props = PropertiesService.getScriptProperties();
  var username = text_(payload.username, 80);
  var password = String(payload.password || "");
  var expectedUser = props.getProperty("ADMIN_USERNAME") || "";
  var storedHash = props.getProperty("ADMIN_PASSWORD_HASH") || "";
  var salt = props.getProperty("ADMIN_PASSWORD_SALT") || "";
  if (!expectedUser || !storedHash || !salt) {
    throw new Error("後台尚未初始化，請先在 Apps Script 執行 initializeNicoPark()。");
  }

  var failKey = "admin_fail_" + digestText_(username || "unknown").slice(0, 24);
  var globalFailKey = "admin_fail_global";
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get(failKey) || "0");
  var globalFails = Number(cache.get(globalFailKey) || "0");
  if (fails >= CONFIG.ADMIN_LOGIN_MAX_FAILS || globalFails >= 20) {
    throw new Error("登入失敗次數過多，請 15 分鐘後再試。");
  }

  var userOk = constantTimeEqual_(username, expectedUser);
  var passwordOk = constantTimeEqual_(hashAdminPassword_(password, salt), storedHash);
  var valid = userOk && passwordOk;
  if (!valid) {
    fails += 1;
    globalFails += 1;
    cache.put(failKey, String(fails), CONFIG.ADMIN_LOGIN_BLOCK_SEC);
    cache.put(globalFailKey, String(globalFails), CONFIG.ADMIN_LOGIN_BLOCK_SEC);
    throw new Error("帳號或密碼不正確。");
  }

  cache.remove(failKey);
  cache.remove(globalFailKey);
  var token = randomToken_() + randomToken_();
  var session = {
    username: expectedUser,
    exp: Date.now() + CONFIG.ADMIN_SESSION_SEC * 1000
  };
  cache.put(adminSessionKey_(token), JSON.stringify(session), CONFIG.ADMIN_SESSION_SEC);
  audit_(expectedUser, "LOGIN_SUCCESS", "admin", "後台登入");
  return {
    success: true,
    status: "success",
    token: token,
    username: expectedUser,
    expiresIn: CONFIG.ADMIN_SESSION_SEC
  };
}

function adminLogout_(payload) {
  var session = requireAdmin_(payload);
  CacheService.getScriptCache().remove(adminSessionKey_(String(payload.token || "")));
  audit_(session.username, "LOGOUT", "admin", "後台登出");
  return { success: true, status: "success" };
}

function adminDashboard_(payload) {
  var session = requireAdmin_(payload);
  var rows = getRecordRows_();
  var cases = aggregateCases_(rows);
  return {
    success: true,
    status: "success",
    username: session.username,
    stats: buildDashboardStats_(cases, rows),
    statuses: CASE_STATUSES,
    sheetUrl: getSheet_().getParent().getUrl(),
    overviewUrl: spreadsheetSheetUrl_(getOwnerOverviewSheet_()),
    sourceUpdatedAt: nowText_()
  };
}

function adminListCases_(payload) {
  requireAdmin_(payload);
  return buildCaseListResponse_(aggregateCases_(getRecordRows_()), payload);
}

function adminSnapshot_(payload) {
  var session = requireAdmin_(payload);
  var rows = getRecordRows_();
  var cases = aggregateCases_(rows);
  var list = buildCaseListResponse_(cases, payload);
  return {
    success: true,
    status: "success",
    username: session.username,
    stats: buildDashboardStats_(cases, rows),
    statuses: CASE_STATUSES,
    cases: list.cases,
    totalMatched: list.totalMatched,
    truncated: list.truncated,
    sheetUrl: getSheet_().getParent().getUrl(),
    overviewUrl: spreadsheetSheetUrl_(getOwnerOverviewSheet_()),
    sourceUpdatedAt: nowText_()
  };
}

function buildCaseListResponse_(cases, payload) {
  var query = text_(payload.query, 120).toLowerCase();
  var statusFilter = text_(payload.statusFilter, 20);
  var dateFrom = text_(payload.dateFrom, 10);
  var dateTo = text_(payload.dateTo, 10);
  cases = cases.filter(function (c) {
    if (statusFilter && statusFilter !== "全部" && c.status !== statusFilter) return false;
    var day = String(c.submittedAt || "").slice(0, 10);
    if (dateFrom && day < dateFrom) return false;
    if (dateTo && day > dateTo) return false;
    if (!query) return true;
    var hay = [
      c.caseId, c.customerId, c.ownerName, c.phone, c.email, c.petNames.join(" ")
    ].join(" ").toLowerCase();
    return hay.indexOf(query) >= 0;
  });
  return {
    success: true,
    status: "success",
    cases: cases.slice(0, CONFIG.MAX_CASES_PER_QUERY),
    totalMatched: cases.length,
    truncated: cases.length > CONFIG.MAX_CASES_PER_QUERY
  };
}

function adminGetCase_(payload) {
  requireAdmin_(payload);
  var caseId = text_(payload.caseId, 80);
  if (!caseId) throw new Error("缺少案件識別碼。");
  var rows = getCaseRowsById_(caseId);
  if (!rows.length) throw new Error("找不到此案件。");
  return { success: true, status: "success", caseData: caseDetailFromRows_(rows) };
}

function adminUpdateCase_(payload) {
  var session = requireAdmin_(payload);
  var caseId = text_(payload.caseId, 80);
  var nextStatus = text_(payload.caseStatus, 20);
  var note = text_(payload.note, 1200);
  if (!caseId) throw new Error("缺少案件識別碼。");
  if (CASE_STATUSES.indexOf(nextStatus) < 0) throw new Error("案件狀態不正確。");

  var changed = withScriptLock_(function () {
    var sh = getSheet_();
    var data = sh.getDataRange().getDisplayValues();
    if (data.length < 2) return 0;
    var index = headerIndex_(data[0]);
    var caseCol = requiredColumn_(index, "案件識別碼");
    var statusCol = requiredColumn_(index, "案件狀態");
    var noteCol = requiredColumn_(index, "店家備註");
    var timeCol = requiredColumn_(index, "最後更新時間");
    var userCol = requiredColumn_(index, "最後更新人員");
    var now = nowText_();
    var count = 0;
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][caseCol]) !== caseId) continue;
      sh.getRange(r + 1, statusCol + 1).setValue(sheetSafe_(nextStatus));
      sh.getRange(r + 1, noteCol + 1).setValue(sheetSafe_(note));
      sh.getRange(r + 1, timeCol + 1).setValue(now);
      sh.getRange(r + 1, userCol + 1).setValue(sheetSafe_(session.username));
      count += 1;
    }
    try { refreshOwnerOverview_(); } catch (overviewErr) {}
    return count;
  });
  if (!changed) throw new Error("找不到此案件。");
  audit_(session.username, "UPDATE_CASE", caseId, "狀態：" + nextStatus + "；備註：" + note.slice(0, 300));
  return {
    success: true,
    status: "success",
    message: "案件已更新",
    updatedRows: changed,
    updatedAt: nowText_()
  };
}

function adminFindCustomers_(payload) {
  requireAdmin_(payload);
  var query = text_(payload.query, 120).toLowerCase();
  if (!query) return { success: true, status: "success", customers: [] };
  var cases = aggregateCases_(getRecordRows_());
  var byCustomer = {};
  cases.forEach(function (c) {
    var hay = [c.customerId, c.ownerName, c.phone, c.email, c.petNames.join(" ")].join(" ").toLowerCase();
    if (hay.indexOf(query) < 0) return;
    var id = c.customerId || "NO-ID-" + c.phone + "-" + c.email;
    if (!byCustomer[id]) {
      byCustomer[id] = {
        customerId: c.customerId,
        ownerName: c.ownerName,
        phone: c.phone,
        email: c.email,
        petNames: [],
        latestAt: c.submittedAt,
        caseCount: 0
      };
    }
    byCustomer[id].caseCount += 1;
    c.petNames.forEach(function (name) { uniquePush_(byCustomer[id].petNames, name); });
    if (String(c.submittedAt) > String(byCustomer[id].latestAt)) byCustomer[id].latestAt = c.submittedAt;
  });
  var customers = Object.keys(byCustomer).map(function (id) { return byCustomer[id]; });
  customers.sort(function (a, b) { return String(b.latestAt).localeCompare(String(a.latestAt)); });
  return { success: true, status: "success", customers: customers.slice(0, 50) };
}

function validateSubmission_(owner, list, payload) {
  if (!text_(owner.name, 50)) throw new Error("請填寫飼主名稱。");
  if (!normalizePhone_(owner.phone)) throw new Error("手機號碼格式不正確。");
  if (!normalizeEmail_(owner.email)) throw new Error("電子信箱格式不正確。");
  if (!list.length || list.length > 5) throw new Error("請填寫 1 至 5 隻毛孩的資料。");
  list.forEach(function (item) {
    var pet = item.pet || {};
    if (!text_(pet.name, 40) || !text_(pet.breed, 40)) throw new Error("毛孩名稱與品種為必填。");
  });
  if (!payload.agreedToTerms) throw new Error("請先同意條款並完成簽署。");
  var sign = String(payload.signatureDataUrl || "");
  if (!/^data:image\/png;base64,/.test(sign)) throw new Error("找不到有效的手寫簽名，請返回上一步重簽。");
  if (sign.length > 2000000) throw new Error("簽名圖檔過大，請清除後重新簽名。");
}

function petsOf_(form) {
  if (form.pets && form.pets.length) {
    return form.pets.map(function (p) { return { pet: p || {}, care: p || {} }; });
  }
  if (form.pet) return [{ pet: form.pet || {}, care: form.care || {} }];
  return [];
}

function appendRecordRow_(ctx) {
  var owner = ctx.owner || {};
  var pet = ctx.pet || {};
  var care = ctx.care || {};
  var payload = ctx.payload || {};
  var guarding = join_(care.guarding);
  if (care.guardingOther) guarding += (guarding ? "；" : "") + text_(care.guardingOther, 100);
  var diseases = join_(care.diseases);
  if (care.diseaseOther) diseases += (diseases ? "；" : "") + text_(care.diseaseOther, 100);
  var deworm = text_(care.deworm, 60);
  if (care.dewormOther) deworm += (deworm ? "；" : "") + text_(care.dewormOther, 100);
  var preventative = text_(care.preventative, 60);
  if (care.preventativeOther) preventative += (preventative ? "；" : "") + text_(care.preventativeOther, 100);

  var values = {
    "案件識別碼": ctx.caseId,
    "送出時間": ctx.submittedAt,
    "客戶編號": ctx.customerId,
    "飼主名稱": text_(owner.name, 50),
    "聯絡電話": normalizePhone_(owner.phone) || "",
    "電子信箱": normalizeEmail_(owner.email) || "",
    "LINE名稱": text_(owner.lineName, 50),
    "緊急聯絡人": text_(owner.emergencyName, 50),
    "緊急聯絡人電話": text_(owner.emergencyPhone, 30),
    "毛寶名字": text_(pet.name, 40),
    "性別": text_(pet.gender, 20),
    "品種": text_(pet.breed, 40),
    "年齡": text_(pet.age, 20),
    "體重kg": text_(pet.weightKg, 20),
    "是否結紮": text_(pet.neutered, 10),
    "是否發情": text_(pet.inHeat, 10),
    "親狗親人": text_(care.sociability, 60),
    "護食護玩具": guarding,
    "牽繩狀況": text_(care.leash, 80),
    "固定獸醫院": text_(care.hasVet, 10),
    "獸醫院名稱與電話": text_(care.vetInfo, 100),
    "近14天健康": join_(care.health14),
    "疾病紀錄": diseases,
    "驅蟲時間": deworm,
    "滴劑口服藥": preventative,
    "注意事項": text_(care.notes, 600),
    "OTP驗證結果": otpResultLabel_(payload.otpChannel),
    "條款版本號": CONFIG.TERMS_VERSION,
    "已同意條款": payload.agreedToTerms ? "是" : "否",
    "簽署時間": prettyTime_(payload.agreedAt) || ctx.submittedAt,
    "雲端資料夾": ctx.folderUrl,
    "PDF連結": ctx.pdfUrl,
    "簽名檔": ctx.signUrl,
    "客戶端裝置資訊": text_(JSON.stringify(payload.device || {}), 4000),
    "案件狀態": "待審核",
    "店家備註": "",
    "最後更新時間": ctx.submittedAt,
    "最後更新人員": "系統"
  };
  appendMappedRow_(getSheet_(), values);
}

function getRootFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = String(CONFIG.FOLDER_ID || props.getProperty("FOLDER_ID") || "");
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (err) {}
  }
  var existing = DriveApp.getRootFolder().getFoldersByName("NicoPark 入園資料");
  var folder = existing.hasNext() ? existing.next() : DriveApp.createFolder("NicoPark 入園資料");
  props.setProperty("FOLDER_ID", folder.getId());
  return folder;
}

function getSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = String(CONFIG.SHEET_ID || props.getProperty("SHEET_ID") || "");
  var ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (err) {}
  }
  if (!ss) {
    var folder = getRootFolder_();
    var files = folder.getFilesByName("NicoPark 入園登記");
    if (files.hasNext()) ss = SpreadsheetApp.open(files.next());
    else {
      ss = SpreadsheetApp.create("NicoPark 入園登記");
      DriveApp.getFileById(ss.getId()).moveTo(folder);
    }
    props.setProperty("SHEET_ID", ss.getId());
  }
  return ss;
}

function getSheet_() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sh) sh = ss.insertSheet(CONFIG.SHEET_NAME, 0);
  ensureHeaders_(sh, SHEET_HEADERS);
  return sh;
}

function getAuditSheet_() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(CONFIG.AUDIT_SHEET_NAME);
  if (!sh) sh = ss.insertSheet(CONFIG.AUDIT_SHEET_NAME);
  ensureHeaders_(sh, AUDIT_HEADERS);
  return sh;
}

function getOwnerOverviewSheet_() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(CONFIG.OVERVIEW_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.OVERVIEW_SHEET_NAME, 0);
    sh.setTabColor("#AC9D8D");
  }
  return sh;
}

function ensureHeaders_(sh, expected) {
  var shouldStyle = false;
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, expected.length).setValues([expected]);
    shouldStyle = true;
  } else {
    var width = Math.max(1, sh.getLastColumn());
    var current = sh.getRange(1, 1, 1, width).getDisplayValues()[0];
    var missing = expected.filter(function (h) { return current.indexOf(h) < 0; });
    if (missing.length) {
      sh.getRange(1, current.length + 1, 1, missing.length).setValues([missing]);
      shouldStyle = true;
    }
  }
  if (shouldStyle) {
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, sh.getLastColumn())
      .setFontWeight("bold")
      .setBackground("#E9D4C2")
      .setFontColor("#4A372D");
  }
}

function appendMappedRow_(sh, values) {
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
  var row = headers.map(function (h) {
    var value = Object.prototype.hasOwnProperty.call(values, h) ? values[h] : "";
    return sheetSafe_(value);
  });
  sh.getRange(sh.getLastRow() + 1, 1, 1, row.length).setValues([row]);
}

function getRecordRows_() {
  var sh = getSheet_();
  var data = sh.getDataRange().getDisplayValues();
  if (data.length < 2) return [];
  var headers = data[0];
  return data.slice(1).map(function (row, index) {
    var out = { _row: index + 2 };
    headers.forEach(function (h, col) { out[h] = row[col] || ""; });
    return out;
  }).filter(function (row) { return !!row["案件識別碼"]; });
}

function getCaseRowsById_(caseId) {
  var sh = getSheet_();
  var lastRow = sh.getLastRow();
  var lastColumn = sh.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) return [];
  var headers = sh.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  var index = headerIndex_(headers);
  var caseCol = requiredColumn_(index, "案件識別碼");
  var matches = sh.getRange(2, caseCol + 1, lastRow - 1, 1)
    .createTextFinder(caseId)
    .matchEntireCell(true)
    .findAll();
  if (!matches.length) return [];

  var firstRow = matches[0].getRow();
  var finalRow = matches[matches.length - 1].getRow();
  var block = sh.getRange(firstRow, 1, finalRow - firstRow + 1, lastColumn).getDisplayValues();
  return block.map(function (row, offset) {
    var out = { _row: firstRow + offset };
    headers.forEach(function (h, col) { out[h] = row[col] || ""; });
    return out;
  }).filter(function (row) {
    return String(row["案件識別碼"]) === caseId;
  });
}

/**
 * 可在 Apps Script 編輯器手動執行，立即重建 Google 試算表的「業主總覽」頁。
 */
function refreshOwnerDashboard() {
  var result = refreshOwnerOverview_();
  Logger.log(JSON.stringify(result));
  return result;
}

/**
 * initializeNicoPark() 會建立此安裝型觸發器。
 * 店家直接編輯「入園登記」時，總覽也會重新計算。
 */
function onNicoParkSheetEdit(e) {
  if (!e || !e.range || e.range.getSheet().getName() !== CONFIG.SHEET_NAME) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    refreshOwnerOverview_();
  } finally {
    lock.releaseLock();
  }
}

function ensureOwnerOverviewEditTrigger_() {
  try {
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === "onNicoParkSheetEdit") return true;
    }
    ScriptApp.newTrigger("onNicoParkSheetEdit")
      .forSpreadsheet(getSpreadsheet_())
      .onEdit()
      .create();
    return true;
  } catch (err) {
    Logger.log("建立業主總覽編輯觸發器失敗：" + err.message);
    return false;
  }
}

function refreshOwnerOverview_() {
  var rows = getRecordRows_();
  var cases = aggregateCases_(rows);
  var stats = buildDashboardStats_(cases, rows);
  var alerts = caseAlertMap_(rows);
  var sh = getOwnerOverviewSheet_();
  var oldFilter = sh.getFilter();
  if (oldFilter) oldFilter.remove();
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  sh.clear();
  sh.setHiddenGridlines(true);
  sh.setFrozenRows(2);
  sh.setTabColor("#AC9D8D");

  var cocoa = "#53453A";
  var paper = "#FFFCF8";
  var warm = "#F8F3EC";
  var oat = "#AC9D8D";
  var oatSoft = "#E7D9CC";
  var line = "#DDD0C3";
  var muted = "#7A6B5E";

  sh.getRange("A1:H1").merge()
    .setValue("NicoPark 業主營運總覽")
    .setBackground(cocoa)
    .setFontColor("#FFFFFF")
    .setFontSize(18)
    .setFontWeight("bold")
    .setHorizontalAlignment("left")
    .setVerticalAlignment("middle");
  sh.setRowHeight(1, 42);
  sh.getRange("A2:H2").merge()
    .setValue("資料來源：入園登記｜最後同步：" + nowText_() + "｜送出表單、後台改狀態或直接編輯資料時自動更新")
    .setBackground("#EFE6DC")
    .setFontColor(muted)
    .setFontSize(10)
    .setVerticalAlignment("middle");
  sh.setRowHeight(2, 28);

  var metricCards = [
    { label: "今日新增", value: stats.today, labelRange: "A4:B4", valueRange: "A5:B6", color: "#E6D1C2" },
    { label: "待處理", value: stats.pending, labelRange: "C4:D4", valueRange: "C5:D6", color: "#E9DFC2" },
    { label: "已確認", value: stats.confirmed, labelRange: "E4:F4", valueRange: "E5:F6", color: "#CFDDD4" },
    { label: "健康提醒案件", value: stats.healthAlerts, labelRange: "G4:H4", valueRange: "G5:H6", color: "#E8D2CC" }
  ];
  metricCards.forEach(function (card) {
    sh.getRange(card.labelRange).merge()
      .setValue(card.label)
      .setBackground(card.color)
      .setFontColor(cocoa)
      .setFontWeight("bold")
      .setHorizontalAlignment("center")
      .setVerticalAlignment("middle");
    sh.getRange(card.valueRange).merge()
      .setValue(card.value)
      .setBackground(paper)
      .setFontColor(cocoa)
      .setFontSize(24)
      .setFontWeight("bold")
      .setHorizontalAlignment("center")
      .setVerticalAlignment("middle");
  });
  sh.getRange("A4:H6").setBorder(true, true, true, true, true, true, line, SpreadsheetApp.BorderStyle.SOLID);
  sh.setRowHeight(4, 27);
  sh.setRowHeights(5, 2, 30);

  sh.getRange("A8:D8").merge().setValue("案件狀態分布");
  sh.getRange("E8:H8").merge().setValue("營運指標定義");
  sh.getRange("A8:H8")
    .setBackground(oat)
    .setFontColor("#FFFFFF")
    .setFontWeight("bold")
    .setVerticalAlignment("middle");

  var statusRows = [["狀態", "案件數", "占比", "建議動作"]];
  var statusActions = {
    "待審核": "檢查資料",
    "待聯繫": "今日聯絡",
    "已確認": "準備接待",
    "已完成": "已結案",
    "已取消": "保留紀錄"
  };
  CASE_STATUSES.forEach(function (status) {
    var count = stats.byStatus[status] || 0;
    statusRows.push([
      status,
      count,
      stats.total ? Math.round(count / stats.total * 100) + "%" : "0%",
      statusActions[status] || ""
    ]);
  });
  sh.getRange(9, 1, statusRows.length, 4).setValues(statusRows);
  sh.getRange("A9:D9").setBackground(warm).setFontWeight("bold").setFontColor(muted);
  sh.getRange("A10:D14").setBackground(paper);

  var definitionRows = [
    ["指標", "目前", "計算方式", "用途"],
    ["全部案件", stats.total, "不重複案件識別碼", "掌握累計量"],
    ["近 7 日", stats.last7Days, "今日起往前 7 天", "觀察近期量"],
    ["毛孩資料", stats.pets, "入園登記資料列數", "一案可多隻"],
    ["不重複客戶", stats.customers, "以客戶編號優先", "掌握客群"],
    ["健康提醒", stats.healthAlerts, "健康異常／疾病／發情", "優先人工確認"]
  ];
  sh.getRange(9, 5, definitionRows.length, 4).setValues(definitionRows);
  sh.getRange("E9:H9").setBackground(warm).setFontWeight("bold").setFontColor(muted);
  sh.getRange("E10:H14").setBackground(paper);
  sh.getRange("A9:H14").setBorder(true, true, true, true, true, true, line, SpreadsheetApp.BorderStyle.SOLID);

  sh.getRange("A16:H16").merge()
    .setValue("最近案件｜最新 15 筆")
    .setBackground(cocoa)
    .setFontColor("#FFFFFF")
    .setFontWeight("bold");
  var recentHeaders = ["送出時間", "狀態", "案件識別碼", "客戶編號", "飼主", "毛孩", "健康提醒", "最後更新"];
  sh.getRange(17, 1, 1, recentHeaders.length).setValues([recentHeaders])
    .setBackground(oatSoft)
    .setFontColor(cocoa)
    .setFontWeight("bold");

  var recentRows = cases.slice(0, 15).map(function (item) {
    return [
      item.submittedAt || "",
      item.status || "待審核",
      item.caseId || "",
      item.customerId || "",
      item.ownerName || "",
      item.petNames.join("、"),
      alerts[item.caseId] ? "需要確認" : "無",
      item.updatedAt || item.submittedAt || ""
    ];
  });
  if (recentRows.length) {
    sh.getRange(18, 1, recentRows.length, 8).setValues(recentRows);
    for (var r = 0; r < recentRows.length; r++) {
      sh.getRange(18 + r, 1, 1, 8).setBackground(r % 2 ? warm : paper);
    }
    sh.getRange(18, 2, recentRows.length, 1).setFontWeight("bold");
    sh.getRange(18, 7, recentRows.length, 1).setFontColor(muted);
    recentRows.forEach(function (row, index) {
      if (row[6] === "需要確認") {
        sh.getRange(18 + index, 7).setFontColor("#9A5848").setFontWeight("bold");
      }
    });
    sh.getRange(17, 1, recentRows.length + 1, 8)
      .setBorder(true, true, true, true, true, true, line, SpreadsheetApp.BorderStyle.SOLID);
  } else {
    sh.getRange("A18:H18").merge()
      .setValue("目前尚無入園案件")
      .setBackground(paper)
      .setFontColor(muted)
      .setHorizontalAlignment("center");
  }

  sh.setColumnWidth(1, 145);
  sh.setColumnWidth(2, 90);
  sh.setColumnWidth(3, 185);
  sh.setColumnWidth(4, 105);
  sh.setColumnWidth(5, 110);
  sh.setColumnWidth(6, 175);
  sh.setColumnWidth(7, 105);
  sh.setColumnWidth(8, 145);
  sh.getRange(1, 1, Math.max(18, 17 + recentRows.length), 8)
    .setFontFamily("Arial")
    .setVerticalAlignment("middle");
  sh.getRange(9, 1, 6, 8).setWrap(true);
  sh.getRange(17, 1, Math.max(2, recentRows.length + 1), 8).setWrap(true);
  SpreadsheetApp.flush();

  return {
    success: true,
    status: "success",
    stats: stats,
    overviewUrl: spreadsheetSheetUrl_(sh),
    refreshedAt: nowText_()
  };
}

function spreadsheetSheetUrl_(sh) {
  return sh.getParent().getUrl() + "#gid=" + sh.getSheetId();
}

function aggregateCases_(rows) {
  var byId = {};
  var order = [];
  rows.forEach(function (row) {
    var id = row["案件識別碼"];
    if (!id) return;
    if (!byId[id]) {
      byId[id] = {
        caseId: id,
        submittedAt: row["送出時間"] || "",
        customerId: row["客戶編號"] || "",
        ownerName: row["飼主名稱"] || "",
        phone: row["聯絡電話"] || "",
        email: row["電子信箱"] || "",
        lineName: row["LINE名稱"] || "",
        petNames: [],
        petCount: 0,
        status: row["案件狀態"] || "待審核",
        note: row["店家備註"] || "",
        pdfUrl: row["PDF連結"] || "",
        updatedAt: row["最後更新時間"] || row["送出時間"] || ""
      };
      order.push(id);
    }
    uniquePush_(byId[id].petNames, row["毛寶名字"]);
    byId[id].petCount = byId[id].petNames.length;
  });
  var cases = order.map(function (id) { return byId[id]; });
  cases.sort(function (a, b) { return String(b.submittedAt).localeCompare(String(a.submittedAt)); });
  return cases;
}

function buildDashboardStats_(cases, rows) {
  var today = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd");
  var sevenDaysAgo = Utilities.formatDate(new Date(Date.now() - 6 * 86400000), "Asia/Taipei", "yyyy-MM-dd");
  var counts = {};
  var customers = {};
  var alertCases = {};
  var todayCount = 0;
  var last7Days = 0;
  var petCount = 0;

  CASE_STATUSES.forEach(function (s) { counts[s] = 0; });
  rows.forEach(function (row) {
    petCount += 1;
    var customerKey = row["客戶編號"] || (normalizePhone_(row["聯絡電話"]) + "|" + normalizeEmail_(row["電子信箱"]));
    if (customerKey) customers[customerKey] = true;
    if (rowHasCareAlert_(row)) alertCases[row["案件識別碼"]] = true;
  });
  cases.forEach(function (c) {
    var status = c.status || "待審核";
    var day = String(c.submittedAt || "").slice(0, 10);
    counts[status] = (counts[status] || 0) + 1;
    if (day === today) todayCount += 1;
    if (day && day >= sevenDaysAgo && day <= today) last7Days += 1;
  });

  return {
    total: cases.length,
    today: todayCount,
    last7Days: last7Days,
    pending: (counts["待審核"] || 0) + (counts["待聯繫"] || 0),
    confirmed: counts["已確認"] || 0,
    completed: counts["已完成"] || 0,
    cancelled: counts["已取消"] || 0,
    pets: petCount,
    customers: Object.keys(customers).length,
    healthAlerts: Object.keys(alertCases).length,
    byStatus: counts
  };
}

function rowHasCareAlert_(row) {
  var health = String(row["近14天健康"] || "").trim();
  var diseases = String(row["疾病紀錄"] || "").trim();
  var inHeat = String(row["是否發情"] || "").trim();
  var healthAlert = health && health.indexOf("以上皆無") < 0;
  var diseaseAlert = diseases && diseases.indexOf("以上皆無") < 0;
  return !!(healthAlert || diseaseAlert || inHeat === "是");
}

function caseAlertMap_(rows) {
  var out = {};
  rows.forEach(function (row) {
    if (rowHasCareAlert_(row)) out[row["案件識別碼"]] = true;
  });
  return out;
}

function caseDetailFromRows_(rows) {
  var first = rows[0];
  return {
    caseId: first["案件識別碼"],
    submittedAt: first["送出時間"],
    customerId: first["客戶編號"],
    status: first["案件狀態"] || "待審核",
    note: first["店家備註"] || "",
    updatedAt: first["最後更新時間"] || "",
    updatedBy: first["最後更新人員"] || "",
    pdfUrl: first["PDF連結"] || "",
    folderUrl: first["雲端資料夾"] || "",
    termsVersion: first["條款版本號"] || "",
    signatureAt: first["簽署時間"] || "",
    otpResult: first["OTP驗證結果"] || "",
    device: first["客戶端裝置資訊"] || "",
    owner: {
      name: first["飼主名稱"] || "",
      phone: first["聯絡電話"] || "",
      email: first["電子信箱"] || "",
      lineName: first["LINE名稱"] || "",
      emergencyName: first["緊急聯絡人"] || "",
      emergencyPhone: first["緊急聯絡人電話"] || ""
    },
    pets: rows.map(function (row) {
      return {
        name: row["毛寶名字"] || "",
        gender: row["性別"] || "",
        breed: row["品種"] || "",
        age: row["年齡"] || "",
        weightKg: row["體重kg"] || "",
        neutered: row["是否結紮"] || "",
        inHeat: row["是否發情"] || "",
        sociability: row["親狗親人"] || "",
        guarding: row["護食護玩具"] || "",
        leash: row["牽繩狀況"] || "",
        hasVet: row["固定獸醫院"] || "",
        vetInfo: row["獸醫院名稱與電話"] || "",
        health14: row["近14天健康"] || "",
        diseases: row["疾病紀錄"] || "",
        deworm: row["驅蟲時間"] || "",
        preventative: row["滴劑口服藥"] || "",
        notes: row["注意事項"] || ""
      };
    })
  };
}

function findLatestEmail_(email) {
  var target = normalizeEmail_(email);
  if (!target) return "";
  var rows = getRecordRows_();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (normalizeEmail_(rows[i]["電子信箱"]) === target) {
      return target;
    }
  }
  return "";
}

function findCustomerIdentityByEmail_(customerId, email) {
  var rows = getRecordRows_();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (normalizeCustomerId_(rows[i]["客戶編號"]) !== customerId) continue;
    if (normalizeEmail_(rows[i]["電子信箱"]) !== normalizeEmail_(email)) continue;
    return { email: normalizeEmail_(email), row: rows[i] };
  }
  return null;
}

function findOrCreateCustomerId_(phone, email) {
  return withScriptLock_(function () {
    var props = PropertiesService.getScriptProperties();
    var propertyKey = "CUSTOMER_" + digestText_(phone + "|" + email).slice(0, 32);
    var saved = normalizeCustomerId_(props.getProperty(propertyKey));
    if (saved) return saved;
    var rows = getRecordRows_();
    for (var i = rows.length - 1; i >= 0; i--) {
      if (normalizePhone_(rows[i]["聯絡電話"]) !== phone) continue;
      if (normalizeEmail_(rows[i]["電子信箱"]) !== email) continue;
      var id = normalizeCustomerId_(rows[i]["客戶編號"]);
      if (id) {
        props.setProperty(propertyKey, id);
        return id;
      }
    }
    var customerId = makeCustomerId_();
    props.setProperty(propertyKey, customerId);
    return customerId;
  });
}

function buildCustomerProfile_(customerId, email) {
  var rows = getRecordRows_().filter(function (row) {
    return normalizeCustomerId_(row["客戶編號"]) === customerId &&
      normalizeEmail_(row["電子信箱"]) === normalizeEmail_(email);
  });
  if (!rows.length) return null;
  rows.sort(function (a, b) {
    return String(b["送出時間"]).localeCompare(String(a["送出時間"]));
  });
  var latestCase = rows[0]["案件識別碼"];
  var latestRows = rows.filter(function (row) { return row["案件識別碼"] === latestCase; });
  var first = latestRows[0];
  return {
    customerId: customerId,
    sourceCaseId: latestCase,
    owner: {
      name: first["飼主名稱"] || "",
      phone: first["聯絡電話"] || "",
      email: first["電子信箱"] || "",
      lineName: first["LINE名稱"] || "",
      emergencyName: first["緊急聯絡人"] || "",
      emergencyPhone: first["緊急聯絡人電話"] || ""
    },
    pets: latestRows.map(function (row) {
      var guarding = splitStored_(row["護食護玩具"]);
      var diseases = splitStored_(row["疾病紀錄"]);
      return {
        name: row["毛寶名字"] || "",
        gender: row["性別"] || "",
        breed: row["品種"] || "",
        age: row["年齡"] || "",
        weightKg: row["體重kg"] || "",
        neutered: row["是否結紮"] || "",
        inHeat: "",
        sociability: row["親狗親人"] || "",
        guarding: guarding.known,
        guardingOther: guarding.other,
        leash: row["牽繩狀況"] || "",
        hasVet: row["固定獸醫院"] || "",
        vetInfo: row["獸醫院名稱與電話"] || "",
        health14: [],
        diseases: diseases.known,
        diseaseOther: diseases.other,
        deworm: "",
        dewormOther: "",
        preventative: row["滴劑口服藥"] === "是" || row["滴劑口服藥"] === "否" ? row["滴劑口服藥"] : "",
        preventativeOther: "",
        notes: row["注意事項"] || ""
      };
    }),
    refreshRequired: ["inHeat", "health14", "deworm"]
  };
}

function splitStored_(value) {
  var parts = String(value || "").split(/[、；]/).map(function (v) { return v.trim(); }).filter(function (v) { return v; });
  var knownLabels = OPTIONS.guarding.concat(OPTIONS.diseases);
  var known = [];
  var extra = [];
  parts.forEach(function (v) {
    if (knownLabels.indexOf(v) >= 0) known.push(v);
    else extra.push(v);
  });
  return { known: known, other: extra.join("；") };
}

function backfillCustomerIds_() {
  return withScriptLock_(function () {
    var sh = getSheet_();
    var data = sh.getDataRange().getDisplayValues();
    if (data.length < 2) return 0;
    var index = headerIndex_(data[0]);
    var customerCol = requiredColumn_(index, "客戶編號");
    var phoneCol = requiredColumn_(index, "聯絡電話");
    var emailCol = requiredColumn_(index, "電子信箱");
    var ids = {};
    var count = 0;
    for (var r = 1; r < data.length; r++) {
      var phone = normalizePhone_(data[r][phoneCol]);
      var email = normalizeEmail_(data[r][emailCol]);
      if (!phone || !email) continue;
      var key = phone + "|" + email;
      var existing = normalizeCustomerId_(data[r][customerCol]);
      if (existing) ids[key] = existing;
      if (!ids[key]) ids[key] = makeCustomerId_();
      if (!existing) {
        sh.getRange(r + 1, customerCol + 1).setValue(ids[key]);
        count += 1;
      }
    }
    return count;
  });
}

function initializeAdminPassword_() {
  var props = PropertiesService.getScriptProperties();
  var username = props.getProperty("ADMIN_USERNAME") || "";
  var initial = props.getProperty("ADMIN_INITIAL_PASSWORD") || "";
  var existing = props.getProperty("ADMIN_PASSWORD_HASH") || "";
  if (existing && username) return true;
  if (!username || !initial) {
    Logger.log("尚未設定 ADMIN_USERNAME 或 ADMIN_INITIAL_PASSWORD");
    return false;
  }
  if (initial.length < 12) throw new Error("ADMIN_INITIAL_PASSWORD 至少需 12 碼。");
  var salt = randomToken_();
  props.setProperty("ADMIN_PASSWORD_SALT", salt);
  props.setProperty("ADMIN_PASSWORD_HASH", hashAdminPassword_(initial, salt));
  props.deleteProperty("ADMIN_INITIAL_PASSWORD");
  return true;
}

function requireAdmin_(payload) {
  var token = String(payload.token || "");
  if (!token) throw new Error("管理登入已失效，請重新登入。");
  var raw = CacheService.getScriptCache().get(adminSessionKey_(token));
  if (!raw) throw new Error("管理登入已失效，請重新登入。");
  var session;
  try { session = JSON.parse(raw); } catch (err) { throw new Error("管理登入已失效，請重新登入。"); }
  if (!session.exp || Date.now() > Number(session.exp)) {
    CacheService.getScriptCache().remove(adminSessionKey_(token));
    throw new Error("管理登入已逾時，請重新登入。");
  }
  return session;
}

function adminSessionKey_(token) {
  return "admin_session_" + digestText_(token).slice(0, 40);
}

function hashAdminPassword_(password, salt) {
  var value = String(salt) + "|" + String(password);
  for (var i = 0; i < 1500; i++) value = digestText_(value + "|" + salt);
  return value;
}

function audit_(username, action, target, detail) {
  try {
    appendMappedRow_(getAuditSheet_(), {
      "時間": nowText_(),
      "管理員": text_(username, 100),
      "操作": text_(action, 80),
      "目標": text_(target, 120),
      "內容": text_(detail, 1000)
    });
  } catch (err) {}
}

function createPdf_(folder, caseId, customerId, tzNow, owner, list, payload, signBlob) {
  var blob = createPdfViaDoc_(caseId, customerId, tzNow, owner, list, payload, signBlob);
  return folder.createFile(blob);
}

function createPdfViaDoc_(caseId, customerId, tzNow, owner, list, payload, signBlob) {
  var doc = DocumentApp.create("NicoPark 入園資料 " + caseId);
  var body = doc.getBody();
  body.setMarginTop(24).setMarginBottom(24).setMarginLeft(28).setMarginRight(28);
  body.clear();

  var title = body.appendTable([["NicoPark 毛孩入園資料暨電子契約", CONFIG.BUSINESS_NAME]]);
  stylePdfCell_(title.getCell(0, 0), true, PDF_PALETTE.title, 15);
  stylePdfCell_(title.getCell(0, 1), false, PDF_PALETTE.title, 8);
  title.setBorderColor(PDF_PALETTE.border);

  appendPdfKeyTable_(body, [
    ["案件識別碼", caseId, "客戶編號", customerId],
    ["送出時間", tzNow, "條款版本", CONFIG.TERMS_VERSION],
    ["飼主名稱", owner.name, "聯絡電話", owner.phone],
    ["電子信箱", owner.email, "LINE 名稱", owner.lineName],
    ["緊急聯絡人", owner.emergencyName, "緊急聯絡電話", owner.emergencyPhone]
  ]);

  // 首頁優先列出需要現場留意的資訊，免除店員逐項翻閱毛孩資料。
  appendPdfCareAlerts_(body, list);

  list.forEach(function (item, i) {
    var pet = item.pet || {};
    var care = item.care || pet;
    appendPdfBar_(body, "毛孩 " + (i + 1) + (pet.name ? "　" + pet.name : ""));
    appendPdfKeyTable_(body, [
      ["毛孩名字", pet.name, "品種", pet.breed],
      ["年齡", pet.age, "體重", pet.weightKg ? pet.weightKg + " kg" : ""],
      ["性別", checksLine_(OPTIONS.gender, pet.gender), "是否結紮", checksLine_(OPTIONS.yesNo, pet.neutered)],
      ["是否發情", checksLine_(OPTIONS.yesNo, pet.inHeat), "親狗親人", checksLine_(OPTIONS.sociability, care.sociability)],
      ["護食／敏感", join_(care.guarding) + extra_(care.guardingOther), "牽繩狀況", care.leash],
      ["固定獸醫院", care.hasVet, "獸醫院", care.vetInfo],
      ["近 14 天健康", join_(care.health14), "疾病紀錄", join_(care.diseases) + extra_(care.diseaseOther)],
      ["驅蟲時間", care.deworm + extra_(care.dewormOther), "滴劑／口服藥", care.preventative + extra_(care.preventativeOther)],
      ["注意事項", care.notes || "（無）", "", ""]
    ]);
  });

  appendPdfBar_(body, "定型化注意事項與個人資料蒐集告知");
  TERMS_SECTIONS.forEach(function (section) {
    var h = body.appendParagraph(section.title);
    h.setBold(true).setFontSize(9).setForegroundColor("#4A372D");
    section.items.forEach(function (item, index) {
      var p = body.appendParagraph((index + 1) + ". " + item);
      p.setFontSize(8).setForegroundColor("#4A372D").setLineSpacing(1.05);
    });
  });

  appendPdfBar_(body, "電子簽署");
  appendPdfKeyTable_(body, [
    ["簽署聲明", payload.agreedToTerms ? "已同意以電子文件與手寫電子簽章完成簽署" : "未同意", "", ""],
    ["簽署時間", prettyTime_(payload.agreedAt) || tzNow, "OTP 驗證", otpResultLabel_(payload.otpChannel)]
  ]);
  var signTable = body.appendTable([["手寫簽名", ""]]);
  stylePdfCell_(signTable.getCell(0, 0), true, PDF_PALETTE.label, 8);
  stylePdfCell_(signTable.getCell(0, 1), false, PDF_PALETTE.cell, 8);
  signTable.setBorderColor(PDF_PALETTE.border);
  try {
    var img = signTable.getCell(0, 1).appendImage(signBlob);
    var iw = Number(img.getWidth()) || 1;
    var ih = Number(img.getHeight()) || 1;
    var scale = Math.min(250 / iw, 90 / ih, 1);
    img.setWidth(Math.max(120, Math.round(iw * scale)));
    img.setHeight(Math.max(40, Math.round(ih * scale)));
  } catch (err) {}

  var evidence = body.appendParagraph(
    "電子證據：案件 " + caseId + "｜客戶 " + customerId + "｜" + tzNow +
    "｜客戶端資訊 " + text_(JSON.stringify(payload.device || {}), 1000)
  );
  evidence.setFontSize(7).setForegroundColor("#8A7364");

  doc.saveAndClose();
  var docFile = DriveApp.getFileById(doc.getId());
  var pdfBlob = docFile.getAs(MimeType.PDF).setName(caseId + "_NicoPark電子契約.pdf");
  docFile.setTrashed(true);
  return pdfBlob;
}

function appendPdfBar_(body, title) {
  var table = body.appendTable([[title]]);
  stylePdfCell_(table.getCell(0, 0), true, PDF_PALETTE.bar, 10, PDF_PALETTE.barText);
  table.setBorderColor(PDF_PALETTE.bar);
}

function appendPdfCareAlerts_(body, list) {
  var alerts = [];

  (list || []).forEach(function (item, index) {
    var pet = item.pet || {};
    var care = item.care || pet;
    var messages = [];
    var health = careAlertList_(care.health14, ["以上皆無"]);
    var diseases = careAlertList_(care.diseases, ["以上皆無"]);
    var guarding = careAlertList_(care.guarding, ["無此狀況"]);
    var name = text_(pet.name, 80) || ("毛孩 " + (index + 1));

    if (health) messages.push("近 14 天健康：" + health);
    if (diseases) messages.push("疾病紀錄：" + diseases + extra_(care.diseaseOther));
    if (care.inHeat === "是") messages.push("目前處於發情階段");
    if (guarding) messages.push("護食／敏感：" + guarding + extra_(care.guardingOther));
    if (care.leash === "看到人車或貓狗會激動暴衝") messages.push("牽繩狀況：" + care.leash);
    if (care.sociability && care.sociability !== "親狗親人") messages.push("社交狀況：" + care.sociability);
    if (text_(care.notes, 300)) messages.push("照護備註：" + text_(care.notes, 300));

    if (messages.length) alerts.push([name, messages.join("\n")]);
  });

  if (!alerts.length) return;

  var bar = body.appendTable([["照護提醒｜請於現場確認"]]);
  stylePdfCell_(bar.getCell(0, 0), true, PDF_PALETTE.alert, 10, "#FFFFFF");
  bar.setBorderColor(PDF_PALETTE.alert);

  var table = body.appendTable(alerts.map(function () { return ["", ""]; }));
  table.setBorderColor(PDF_PALETTE.border);
  alerts.forEach(function (row, i) {
    stylePdfCell_(table.getCell(i, 0), true, PDF_PALETTE.alertSoft, 8);
    stylePdfCell_(table.getCell(i, 1), false, PDF_PALETTE.cell, 8);
    table.getCell(i, 0).getChild(0).asParagraph().setText(row[0]);
    table.getCell(i, 1).getChild(0).asParagraph().setText(row[1]);
  });
}

function careAlertList_(value, excluded) {
  var ignored = excluded || [];
  var list = Array.isArray(value) ? value : (value ? [value] : []);
  return list.map(function (item) { return text_(item, 100); })
    .filter(function (item) { return item && ignored.indexOf(item) < 0; })
    .join("、");
}

function appendPdfKeyTable_(body, rows) {
  var table = body.appendTable(rows.map(function () { return ["", "", "", ""]; }));
  table.setBorderColor(PDF_PALETTE.border);
  rows.forEach(function (row, r) {
    stylePdfCell_(table.getCell(r, 0), true, PDF_PALETTE.label, 8);
    stylePdfCell_(table.getCell(r, 1), false, PDF_PALETTE.cell, 9);
    stylePdfCell_(table.getCell(r, 2), !!row[2], row[2] ? PDF_PALETTE.label : PDF_PALETTE.cell, 8);
    stylePdfCell_(table.getCell(r, 3), false, PDF_PALETTE.cell, 9);
    table.getCell(r, 0).getChild(0).asParagraph().setText(String(row[0] || " "));
    table.getCell(r, 1).getChild(0).asParagraph().setText(String(row[1] == null || row[1] === "" ? "—" : row[1]));
    table.getCell(r, 2).getChild(0).asParagraph().setText(String(row[2] || " "));
    table.getCell(r, 3).getChild(0).asParagraph().setText(String(row[3] == null || row[3] === "" ? "—" : row[3]));
  });
}

function stylePdfCell_(cell, bold, background, size, color) {
  cell.setBackgroundColor(background || PDF_PALETTE.cell);
  cell.setPaddingTop(4).setPaddingBottom(4).setPaddingLeft(6).setPaddingRight(6);
  var paragraph = cell.getChild(0).asParagraph();
  paragraph.setBold(!!bold).setFontSize(size || 9).setForegroundColor(color || PDF_PALETTE.text);
}

function sendCustomerMail_(owner, names, caseId, customerId, pdfFile) {
  var email = normalizeEmail_(owner.email);
  if (!email) return;
  var petLabel = names.length ? names.join("、") : "毛孩";
  var opts = {
    to: email,
    subject: "【尼口尼口寵物精緻美容旅館】入園資料確認暨電子契約副本",
    name: "Nico Nico Pet House",
    body:
      text_(owner.name, 50) + " 您好，\n\n" +
      "我們已收到 " + petLabel + " 的入園資料與電子簽署。\n" +
      "案件識別碼：" + caseId + "\n" +
      "客戶編號：" + customerId + "\n\n" +
      "客戶編號可在下次登記時安全帶入舊資料，仍需以登記手機與電子信箱驗證。\n" +
      "電子契約 PDF 已附在本信，請妥善保存。\n\n" +
      CONFIG.BUSINESS_NAME + "\n"
  };
  if (CONFIG.ATTACH_PDF && pdfFile) {
    opts.attachments = [pdfFile.getBlob().setName(caseId + "_NicoPark電子契約.pdf")];
  }
  sendMailSafe_(opts);
}

function sendBusinessMail_(to, owner, names, caseId, customerId, pdfFile, folderUrl) {
  var opts = {
    to: to,
    subject: "【新入園／簽署通知】" + text_(owner.name, 50) + " - " + names.join("、"),
    name: "NicoPark",
    body:
      "新的入園資料已寫入試算表並存入雲端。\n\n" +
      "案件識別碼：" + caseId + "\n" +
      "客戶編號：" + customerId + "\n" +
      "飼主：" + text_(owner.name, 50) + "\n" +
      "聯絡電話：" + normalizePhone_(owner.phone) + "\n" +
      "毛孩：" + names.join("、") + "\n" +
      "雲端資料夾：" + folderUrl + "\n"
  };
  if (CONFIG.ATTACH_PDF && pdfFile) {
    opts.attachments = [pdfFile.getBlob().setName(caseId + "_NicoPark電子契約.pdf")];
  }
  sendMailSafe_(opts);
}

function sendMailSafe_(opts) {
  if (CONFIG.SEND_MAIL === false) throw new Error("目前暫停寄信。");
  if (hourCount_("mail") >= CONFIG.MAIL_HOUR_CAP) throw new Error("本小時寄信次數已達上限，請稍後再試。");
  MailApp.sendEmail(opts);
  bumpHour_("mail");
}

/**
 * 所有公開流程均使用電子郵件 OTP；聯絡電話只作店家聯繫用途。
 */
function otpResultLabel_() {
  return "通過（電子信箱）";
}

function getBusinessEmail_() {
  return normalizeEmail_(CONFIG.BUSINESS_EMAIL || PropertiesService.getScriptProperties().getProperty("BUSINESS_EMAIL"));
}

function verifyOtp_(email, otp, purpose, customerId) {
  var normalizedEmail = normalizeEmail_(email);
  if (!normalizedEmail) throw new Error("電子信箱格式不正確。");
  if (!/^\d{6}$/.test(String(otp || ""))) throw new Error("請輸入 6 位數驗證碼。");
  var rec = readOtp_(normalizedEmail, purpose, customerId);
  if (Date.now() > Number(rec.exp || 0)) {
    consumeOtp_(normalizedEmail, purpose, customerId);
    throw new Error("驗證碼已過期，請重新發送。");
  }
  if (String(rec.purpose) !== String(purpose)) throw new Error("驗證碼用途不符，請重新發送。");
  if (purpose === "prefill" && String(rec.customerId) !== String(customerId)) {
    throw new Error("客戶編號驗證失敗，請重新發送。");
  }
  rec.tries = Number(rec.tries || 0) + 1;
  if (rec.tries > CONFIG.OTP_MAX_TRIES) {
    consumeOtp_(normalizedEmail, purpose, customerId);
    throw new Error("驗證碼錯誤次數過多，請重新發送。");
  }
  var actual = otpDigest_(normalizedEmail, purpose, customerId, otp, rec.nonce);
  if (!constantTimeEqual_(actual, rec.hash)) {
    var ttl = Math.max(1, Math.floor((Number(rec.exp) - Date.now()) / 1000));
    CacheService.getScriptCache().put(otpKey_(normalizedEmail, purpose, customerId), JSON.stringify(rec), ttl);
    throw new Error("驗證碼不正確，請再試一次。");
  }
  return rec;
}

function readOtp_(email, purpose, customerId) {
  var raw = CacheService.getScriptCache().get(otpKey_(email, purpose, customerId));
  if (!raw) throw new Error("驗證碼已過期或尚未發送，請重新取得驗證碼。");
  try { return JSON.parse(raw); } catch (err) { throw new Error("驗證資料無效，請重新取得驗證碼。"); }
}

function consumeOtp_(email, purpose, customerId) {
  CacheService.getScriptCache().remove(otpKey_(email, purpose, customerId));
}

function otpKey_(email, purpose, customerId) {
  return "otp_" + digestText_([normalizeEmail_(email), purpose || "", customerId || ""].join("|")).slice(0, 28);
}

function otpDigest_(email, purpose, customerId, code, nonce) {
  return digestText_([normalizeEmail_(email), purpose, customerId || "", code, nonce].join("|"));
}

function hourKey_(kind) {
  return "hour_" + kind + "_" + Utilities.formatDate(new Date(), "Asia/Taipei", "yyyyMMddHH");
}

function hourCount_(kind) {
  var n = Number(CacheService.getScriptCache().get(hourKey_(kind)) || "0");
  return isNaN(n) ? 0 : n;
}

function bumpHour_(kind) {
  var key = hourKey_(kind);
  CacheService.getScriptCache().put(key, String(hourCount_(kind) + 1), 3600);
}

function withScriptLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function headerIndex_(headers) {
  var out = {};
  headers.forEach(function (h, i) { out[h] = i; });
  return out;
}

function requiredColumn_(index, header) {
  if (!Object.prototype.hasOwnProperty.call(index, header)) throw new Error("試算表缺少欄位：" + header);
  return index[header];
}

function sheetSafe_(value) {
  var s = value == null ? "" : String(value);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function normalizePhone_(raw) {
  var s = String(raw || "").replace(/[^\d+]/g, "");
  if (s.charAt(0) === "+") s = s.slice(1);
  if (s.indexOf("8860") === 0) s = s.slice(3);
  else if (s.indexOf("886") === 0) s = "0" + s.slice(3);
  if (/^9\d{8}$/.test(s)) s = "0" + s;
  return /^09\d{8}$/.test(s) ? s : "";
}

function normalizeEmail_(raw) {
  var email = String(raw || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function normalizeCustomerId_(raw) {
  var id = String(raw || "").trim().toUpperCase().replace(/\s/g, "");
  return /^CUS-[A-Z0-9]{6}$/.test(id) ? id : "";
}

function text_(value, max) {
  var s = value == null ? "" : String(value).trim();
  return typeof max === "number" ? s.slice(0, max) : s;
}

function join_(value) {
  if (Array.isArray(value)) {
    return value.map(function (v) { return text_(v, 100); }).filter(function (v) { return v; }).join("、");
  }
  return text_(value, 1000);
}

function selectedMap_(value) {
  var map = {};
  var list = Array.isArray(value) ? value : (value ? [value] : []);
  list.forEach(function (item) { map[String(item)] = true; });
  return map;
}

function checksLine_(items, selected) {
  var map = selectedMap_(selected);
  return items.map(function (label) { return (map[label] ? "☑ " : "☐ ") + label; }).join("　");
}

function extra_(value) {
  return value ? "（" + text_(value, 200) + "）" : "";
}

function uniquePush_(list, value) {
  value = text_(value, 100);
  if (value && list.indexOf(value) < 0) list.push(value);
}

function makeCaseId_() {
  var day = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyyMMdd");
  return "NICO-" + day + "-" + randomAlphaNum_(6);
}

function makeCustomerId_() {
  return "CUS-" + randomAlphaNum_(6);
}

function randomAlphaNum_(length) {
  var alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  var out = "";
  for (var i = 0; i < length; i++) out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  return out;
}

function randomDigits_(length) {
  var out = "";
  for (var i = 0; i < length; i++) out += String(Math.floor(Math.random() * 10));
  return out;
}

function randomToken_() {
  return Utilities.getUuid().replace(/-/g, "") + randomAlphaNum_(12);
}

function digestText_(value) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value),
    Utilities.Charset.UTF_8
  );
  return bytes.map(function (b) {
    var n = b < 0 ? b + 256 : b;
    return ("0" + n.toString(16)).slice(-2);
  }).join("");
}

function constantTimeEqual_(a, b) {
  a = String(a || "");
  b = String(b || "");
  var diff = a.length ^ b.length;
  var len = Math.max(a.length, b.length);
  for (var i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function maskEmail_(email) {
  var parts = String(email || "").split("@");
  if (parts.length !== 2) return "您的信箱";
  var local = parts[0];
  var visible = local.slice(0, Math.min(2, local.length));
  return visible + "***@" + parts[1];
}

function maskPhone_(phone) {
  return String(phone || "").replace(/^(\d{4})\d{3}(\d{3})$/, "$1***$2");
}

function nowText_() {
  return Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
}

function prettyTime_(value) {
  if (!value) return "";
  try {
    var d = new Date(value);
    if (!isNaN(d.getTime())) return Utilities.formatDate(d, "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
  } catch (err) {}
  return text_(value, 80);
}

function safeName_(value) {
  return String(value || "").replace(/[\\/:*?"<>|]/g, "").slice(0, 20) || "毛孩";
}

function dataUrlToBlob_(dataUrl, name) {
  var match = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("簽名圖檔格式不正確，請清除後重簽。");
  return Utilities.newBlob(Utilities.base64Decode(match[2]), match[1], name);
}

function parsePayload_(e) {
  if (!e) return {};
  if (e.postData && e.postData.contents) {
    var raw = e.postData.contents;
    try { return JSON.parse(raw); } catch (err1) {}
    try {
      var params = {};
      String(raw).split("&").forEach(function (part) {
        var i = part.indexOf("=");
        if (i < 0) return;
        var key = decodeURIComponent(part.slice(0, i).replace(/\+/g, " "));
        var value = decodeURIComponent(part.slice(i + 1).replace(/\+/g, " "));
        params[key] = value;
      });
      if (params.payload) return JSON.parse(params.payload);
      return params;
    } catch (err2) {}
  }
  if (e.parameter && e.parameter.payload) {
    try { return JSON.parse(e.parameter.payload); } catch (err3) {}
  }
  return e.parameter || {};
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function friendlyErr_(err) {
  var message = String(err && err.message ? err.message : err || "");
  if (/Authorization|Access denied|授權|權限/i.test(message)) {
    return "Google 尚未授權雲端、試算表或寄信權限，請由管理者重新執行 initializeNicoPark() 完成授權。";
  }
  if (/limit|quota|Mail service|Gmail|寄信/i.test(message)) {
    return "Google 目前暫時限制寄信，請稍後再試；已完成的資料仍會保留在試算表與雲端。";
  }
  return message || "伺服器暫時無法處理，請稍後再試。";
}
